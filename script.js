document.addEventListener('DOMContentLoaded', () => {

    // ==========================================================================
    // 1. معالجة تسجيل الدخول العادي (Email & Password)
    // ==========================================================================
    const loginForm = document.getElementById('login-form');

    if (loginForm) {
        loginForm.addEventListener('submit', async (event) => {
            event.preventDefault();

            const email = document.getElementById('email').value.trim();
            const password = document.getElementById('password').value.trim();

            try {
                // إرسال الطلب للـ API في Cloudflare
                const response = await fetch('/api/auth', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        action: 'login',
                        email: email,
                        password: password
                    })
                });

                const result = await response.json();

                if (response.ok && result.success) {
                    // حفظ بيانات المستخدم في المتصفح
                    localStorage.setItem('user', JSON.stringify(result.user));
                    alert('تم تسجيل الدخول بنجاح!');
                    window.location.href = 'index.html';
                } else {
                    alert(result.error || 'فشل تسجيل الدخول، تحقق من البيانات.');
                }
            } catch (err) {
                console.error(err);
                alert('حدث خطأ أثناء الاتصال بالسيرفر.');
            }
        });
    }

    // ==========================================================================
    // 2. معالجة إنشاء حساب جديد (الاسم + الإيميل + الباسورد)
    // ==========================================================================
    const registerForm = document.getElementById('register-form');

    if (registerForm) {
        registerForm.addEventListener('submit', async (event) => {
            event.preventDefault();

            const name = document.getElementById('reg-name').value.trim();
            const email = document.getElementById('reg-email').value.trim();
            const password = document.getElementById('reg-password').value;
            const confirmPassword = document.getElementById('reg-confirm-password').value;

            if (!name || !email || !password || !confirmPassword) {
                alert('من فضلك املأ كل الحقول');
                return;
            }

            if (password !== confirmPassword) {
                alert('كلمة المرور وتأكيدها مش متطابقين');
                return;
            }

            if (password.length < 6) {
                alert('كلمة المرور لازم تكون 6 حروف على الأقل');
                return;
            }

            const submitBtn = document.getElementById('register-submit-btn');
            const originalText = submitBtn.textContent;
            submitBtn.disabled = true;
            submitBtn.textContent = 'جاري إنشاء الحساب...';

            try {
                const response = await fetch('/api/auth', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'register', name, email, password })
                });

                const result = await response.json();

                if (response.ok && result.success) {
                    localStorage.setItem('user', JSON.stringify(result.user));
                    alert('تم إنشاء الحساب بنجاح!');
                    window.location.href = 'index.html';
                } else {
                    alert(result.error || 'فشل إنشاء الحساب، حاول مرة أخرى.');
                }
            } catch (err) {
                console.error(err);
                alert('حدث خطأ أثناء الاتصال بالسيرفر.');
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = originalText;
            }
        });
    }

});

// ==========================================================================
// 3. معالجة تسجيل الدخول عبر Google
// ملحوظة: مكتبة جوجل بترسم الزرار وتستدعي الدالة دي تلقائياً بنفسها
// عن طريق data-callback الموجودة في login.html (مفيش أي تعديل في الزرار نفسه)
// عشان كده لازم الدالة تفضل معرّفة على window، مش جوه أي Scope مقفول
// ==========================================================================
async function handleGoogleLogin(googleResponse) {
    try {
        const response = await fetch('/api/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'google',
                googleToken: googleResponse.credential
            })
        });

        const result = await response.json();

        if (response.ok && result.success) {
            localStorage.setItem('user', JSON.stringify(result.user));
            alert(`أهلاً بك يا ${result.user.name || ''}! تم التسجيل وحفظ البيانات بنجاح.`);
            window.location.href = 'index.html';
        } else {
            alert(result.error || 'فشل الاتصال بقاعدة البيانات عبر جوجل.');
        }
    } catch (err) {
        console.error(err);
        alert('حدث خطأ أثناء معالجة حساب جوجل.');
    }
}

window.handleGoogleLogin = handleGoogleLogin;
