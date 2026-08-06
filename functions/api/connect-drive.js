/**
 * Cloudflare Pages Function: /api/connect-drive
 * استقبال Authorization Code من صلاحية Drive الإضافية، وتبديله بـ access/refresh tokens
 * وتخزينهم في D1 (جدول google_tokens)
 */
export async function onRequestPost(context) {
    const { request, env } = context;

    if (!env.DB) {
        return jsonError('قاعدة البيانات غير مربوطة (DB).', 500);
    }
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
        return jsonError('بيانات OAuth بتاعة Google (Client ID/Secret) غير مربوطة بالمشروع.', 500);
    }

    let body;
    try {
        body = await request.json();
    } catch {
        return jsonError('بيانات الطلب غير صحيحة.', 400);
    }

    const { code, email, redirectUri } = body;
    if (!code || !email) {
        return jsonError('بيانات ناقصة (code أو email).', 400);
    }

    try {
        // تبديل الكود بـ access_token و refresh_token
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: env.GOOGLE_CLIENT_ID,
                client_secret: env.GOOGLE_CLIENT_SECRET,
                redirect_uri: redirectUri || 'postmessage',
                grant_type: 'authorization_code'
            })
        });

        const tokenData = await tokenRes.json();

        if (!tokenRes.ok) {
            return jsonError('فشل تبادل رمز الموافقة: ' + (tokenData.error_description || tokenData.error), 400);
        }

        const { access_token, refresh_token, expires_in } = tokenData;
        const expiresAt = Date.now() + (expires_in * 1000);

        // تخزين/تحديث التوكينز في D1 (لو المستخدم عنده صف قديم، بنحدّثه)
        const existing = await env.DB.prepare("SELECT id FROM google_tokens WHERE user_email = ?")
            .bind(email).first();

        if (existing) {
            // لو مفيش refresh_token جديد (جوجل بترجعه مرة واحدة بس أول موافقة)، نحافظ على القديم
            if (refresh_token) {
                await env.DB.prepare(
                    "UPDATE google_tokens SET access_token = ?, refresh_token = ?, expires_at = ? WHERE user_email = ?"
                ).bind(access_token, refresh_token, expiresAt, email).run();
            } else {
                await env.DB.prepare(
                    "UPDATE google_tokens SET access_token = ?, expires_at = ? WHERE user_email = ?"
                ).bind(access_token, expiresAt, email).run();
            }
        } else {
            await env.DB.prepare(
                "INSERT INTO google_tokens (user_email, access_token, refresh_token, expires_at) VALUES (?, ?, ?, ?)"
            ).bind(email, access_token, refresh_token || null, expiresAt).run();
        }

        return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (err) {
        return jsonError(err.message, 500);
    }
}

function jsonError(message, status) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}
