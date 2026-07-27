// Cloudflare Pages Function
// 경로: /api/certificate  (POST)
// 역할: 캡차 검증 → 기간 검증 → 이름+생년월일 DB 조회 → 비공개 PDF를 서버에서 받아 그대로 스트리밍

export async function onRequestPost(context) {
  const { request, env } = context;

  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });

  try {
    const { name, birthdate, token } = await request.json();

    // ── 1) 입력 검증 ──────────────────────────────
    if (!name || !birthdate) {
      return json({ error: '이름과 생년월일을 입력해 주세요.' }, 400);
    }
    // 생년월일 형식 검증 (YYYY-MM-DD)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthdate)) {
      return json({ error: '생년월일 형식이 올바르지 않습니다.' }, 400);
    }

    // ── 2) 다운로드 기간 검증 ─────────────────────
    const now = new Date();
    if (env.AVAILABLE_FROM && now < new Date(env.AVAILABLE_FROM)) {
      return json({ error: '아직 다운로드 기간이 아닙니다.' }, 403);
    }
    if (env.AVAILABLE_UNTIL && now > new Date(env.AVAILABLE_UNTIL)) {
      return json({ error: '다운로드 기간이 종료되었습니다.' }, 403);
    }

    // ── 3) (선택) 캡차 검증 ───────────────────────
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

    // ── 4) Supabase DB 조회 (service_role, RLS 우회) ──
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
    if (!dbRes.ok) {
      return json({ error: '조회 중 오류가 발생했습니다.' }, 500);
    }
    const rows = await dbRes.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      return json({ error: '일치하는 이수 정보가 없습니다. 입력값을 확인해 주세요.' }, 404);
    }
    const path = rows[0].storage_path;

    // ── 5) Storage Signed URL 발급 ────────────────
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
    if (!signRes.ok) {
      return json({ error: '파일을 찾을 수 없습니다.' }, 404);
    }
    const { signedURL } = await signRes.json();
    const fileURL = `${env.SUPABASE_URL}/storage/v1${signedURL}`;

    // ── 6) 서버가 PDF를 받아 그대로 스트리밍(프록시) ──
    //     (Signed URL을 브라우저에 직접 노출하지 않음 → 더 안전)
    const fileRes = await fetch(fileURL);
    if (!fileRes.ok) {
      return json({ error: '파일 다운로드에 실패했습니다.' }, 502);
    }

    const filename = encodeURIComponent(`${name}_직무연수이수증.pdf`);
    return new Response(fileRes.body, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
        'Cache-Control': 'no-store'
      }
    });
  } catch (e) {
    return json({ error: '서버 오류가 발생했습니다.' }, 500);
  }
}
