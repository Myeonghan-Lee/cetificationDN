// Cloudflare Pages Function  ( /api/certificate )

// 담당자 연락처 기본값 (환경변수 SUPPORT_CONTACT 미설정 시 사용)
const DEFAULT_CONTACT = '02-2600-0842';

// 서버 시각 기준으로 다운로드 상태를 판정한다.
//   'before' : 시작 전 / 'ended' : 종료 후 / 'open' : 다운로드 가능
function computeStatus(env, now) {
  if (env.AVAILABLE_FROM && now < new Date(env.AVAILABLE_FROM)) return 'before';
  if (env.AVAILABLE_UNTIL && now > new Date(env.AVAILABLE_UNTIL)) return 'ended';
  return 'open';
}

// ── [기능1 + 기능A/B/C] 기간·상태 조회 (GET) ──
//   비밀키는 반환하지 않고, 기간 값 + 상태 + 담당자 연락처만 내려준다.
export async function onRequestGet(context) {
  const { env } = context;
  const status = computeStatus(env, new Date());
  return new Response(
    JSON.stringify({
      from:    env.AVAILABLE_FROM  || null,
      until:   env.AVAILABLE_UNTIL || null,
      status:  status,                              // 'before' | 'open' | 'ended'
      contact: env.SUPPORT_CONTACT || DEFAULT_CONTACT
    }),
    { headers: { 'Content-Type': 'application/json; charset=utf-8' } }
  );
}

// ── 다운로드 (POST) : 캡차 → 기간 → DB 조회 → PDF 프록시 스트리밍 ──
export async function onRequestPost(context) {
  const { request, env } = context;

  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });

  try {
    const { name, birthdate, token } = await request.json();

    // 1) 입력 검증
    if (!name || !birthdate) {
      return json({ error: '이름과 생년월일을 입력해 주세요.' }, 400);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthdate)) {
      return json({ error: '생년월일 형식이 올바르지 않습니다.' }, 400);
    }

    // 2) 다운로드 기간 검증 (실제 차단은 서버가 담당 · 프론트 숨김과 이중 안전장치)
    const now = new Date();
    const contact = env.SUPPORT_CONTACT || DEFAULT_CONTACT;
    if (env.AVAILABLE_FROM && now < new Date(env.AVAILABLE_FROM)) {
      return json({ error: '아직 다운로드 기간이 아닙니다.' }, 403);
    }
    if (env.AVAILABLE_UNTIL && now > new Date(env.AVAILABLE_UNTIL)) {
      // 프론트가 폼을 감추지 못한 경우(직접 POST 등)에도 동일 안내로 차단
      return json({ error: `다운로드 기간이 종료되었습니다. 업무담당자(${contact})에게 연락주십시오!` }, 403);
    }

    // 3) (선택) 캡차 검증
    if (env.TURNSTILE_SECRET) {
      const form = new FormData();
      form.append('secret', env.TURNSTILE_SECRET);
      form.append('response', token || '');
      const cap = await fetch(
        '<https://challenges.cloudflare.com/turnstile/v0/siteverify>',
        { method: 'POST', body: form }
      );
      const capData = await cap.json();
      if (!capData.success) {
        return json({ error: '캡차 인증에 실패했습니다.' }, 403);
      }
    }

    // 4) Supabase DB 조회 (service_role, RLS 우회)
    const q = new URL(`${env.SUPABASE_URL}/rest/v1/certificates`);
    q.searchParams.set('select', 'storage_path');
    q.searchParams.set('name', `eq.${name}`);
    q.searchParams.set('birthdate', `eq.${birthdate}`);
    q.searchParams.set('limit', '1');

    const dbRes = await fetch(q.toString(), {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`
      }
    });
    if (!dbRes.ok) return json({ error: '조회 중 오류가 발생했습니다.' }, 500);
    const rows = await dbRes.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      return json({ error: '일치하는 이수 정보가 없습니다. 입력값을 확인해 주세요.' }, 404);
    }
    const path = rows[0].storage_path;

    // 5) Storage Signed URL 발급
    const ttl = parseInt(env.SIGNED_URL_TTL || '60', 10);
    const signRes = await fetch(
      `${env.SUPABASE_URL}/storage/v1/object/sign/${env.BUCKET}/${encodeURI(path)}`,
      {
        method: 'POST',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ expiresIn: ttl })
      }
    );
    if (!signRes.ok) return json({ error: '파일을 찾을 수 없습니다.' }, 404);
    const { signedURL } = await signRes.json();
    const fileURL = `${env.SUPABASE_URL}/storage/v1${signedURL}`;

    // 6) 서버가 PDF를 받아 그대로 스트리밍(프록시)
    const fileRes = await fetch(fileURL);
    if (!fileRes.ok) return json({ error: '파일 다운로드에 실패했습니다.' }, 502);

    const filename = encodeURIComponent(`${name}_직무연수이수증.pdf`);
    return new Response(fileRes.body, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename*=UTF-8''${filename}`,
        'Cache-Control': 'no-store'
      }
    });
  } catch (e) {
    return json({ error: '서버 오류가 발생했습니다.' }, 500);
  }
}
