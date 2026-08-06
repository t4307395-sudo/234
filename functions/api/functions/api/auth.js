/**
 * Cloudflare Pages Function: /api/auth
 */
export async function onRequestPost(context) {
    const { request, env } = context;

    // تحقق إن قاعدة البيانات مربوطة أصلاً بالمشروع
    if (!env.DB) {
        return new Response(
            JSON.stringify({ error: 'قاعدة البيانات غير مربوطة بالمشروع. تأكد من إضافة D1 binding باسم DB في إعدادات Pages > Settings > Functions.' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }

    const db = env.DB;

    let body;
    try {
        body = await request.json();
    } catch {
        return new Response(JSON.stringify({ error: 'بيانات الطلب غير صحيحة' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const { action, name, email, password, googleToken } = body;

    try {
        // -------------------------------------------------------------
        // 1. تسجيل الدخول / إنشاء حساب عبر Google
        //    (نفس المسار ده بيتستخدم في: تسجيل الدخول العادي بجوجل،
        //     التسجيل لأول مرة بجوجل، وكمان حل "نسيت كلمة المرور")
        // -------------------------------------------------------------
        if (action === 'google') {
            const googleRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${googleToken}`);
            if (!googleRes.ok) {
                return new Response(JSON.stringify({ error: 'رمز جوجل غير صالح' }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            const payload = await googleRes.json();
            const { sub: googleId, email: googleEmail, name: googleName, picture } = payload;

            // ابحث عن المستخدم بالـ google_id أو بالإيميل (مهم عشان حالة نسيان كلمة المرور)
            let user = await db.prepare("SELECT * FROM users WHERE google_id = ? OR email = ?")
                .bind(googleId, googleEmail)
                .first();

            if (!user) {
                // مستخدم جديد تماماً
                await db.prepare(
                    "INSERT INTO users (email, name, google_id, auth_provider, picture) VALUES (?, ?, ?, 'google', ?)"
                ).bind(googleEmail, googleName, googleId, picture).run();

                user = await db.prepare("SELECT * FROM users WHERE google_id = ?").bind(googleId).first();

            } else if (!user.google_id) {
                // فيه حساب أصلاً بنفس الإيميل (اتسجل بباسورد عادي) ومعندوش google_id
                // ده حل "نسيت كلمة المرور": نربط حساب جوجل بنفس الحساب القديم بدل ما نعمل حساب جديد
                await db.prepare("UPDATE users SET google_id = ?, picture = COALESCE(picture, ?) WHERE id = ?")
                    .bind(googleId, picture, user.id)
                    .run();

                user = await db.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first();
            }

            return new Response(JSON.stringify({ success: true, user }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // -------------------------------------------------------------
        // 2. إنشاء حساب جديد بالإيميل والباسورد
        // -------------------------------------------------------------
        if (action === 'register') {
            if (!name || !email || !password) {
                return new Response(JSON.stringify({ error: 'من فضلك أدخل الاسم والبريد الإلكتروني وكلمة المرور' }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            if (password.length < 6) {
                return new Response(JSON.stringify({ error: 'كلمة المرور لازم تكون 6 حروف على الأقل' }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            const existing = await db.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
            if (existing) {
                return new Response(JSON.stringify({ error: 'البريد الإلكتروني مستخدم بالفعل، جرب تسجيل الدخول' }), {
                    status: 409,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            const hashedPassword = await hashPassword(password);

            await db.prepare(
                "INSERT INTO users (email, name, password_hash, auth_provider) VALUES (?, ?, ?, 'email')"
            ).bind(email, name, hashedPassword).run();

            const user = await db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();

            return new Response(JSON.stringify({ success: true, user }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // -------------------------------------------------------------
        // 3. تسجيل الدخول العادي (Email & Password)
        // -------------------------------------------------------------
        if (action === 'login') {
            const user = await db.prepare("SELECT * FROM users WHERE email = ? AND auth_provider = 'email'")
                .bind(email)
                .first();

            if (!user) {
                return new Response(JSON.stringify({ error: 'البريد الإلكتروني غير مسجل، جرب تسجيل الدخول بجوجل أو أنشئ حساب جديد' }), {
                    status: 404,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            const hashedPassword = await hashPassword(password);
            if (user.password_hash !== hashedPassword) {
                return new Response(JSON.stringify({ error: 'كلمة المرور غير صحيحة' }), {
                    status: 401,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            return new Response(JSON.stringify({ success: true, user }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        return new Response(JSON.stringify({ error: 'إجراء غير معروف' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

// دالة تشفير كلمة المرور (SHA-256)
async function hashPassword(password) {
    const msgUint8 = new TextEncoder().encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
