/**
 * منطق صفحة محلل المواقع: الفحص + عرض النتائج + ربط Drive الحفظ
 */

const GOOGLE_CLIENT_ID = '205809787174-a73p118a4mmkpn6cju1dnqcm07eut7v4.apps.googleusercontent.com';
const DRIVE_SCOPES = 'https://www.googleapis.com/auth/drive.file';

let lastReport = null;
let driveCodeClient = null;

function getCurrentUser() {
    try {
        return JSON.parse(localStorage.getItem('user'));
    } catch {
        return null;
    }
}

// ============================================================
// فحص الموقع
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('analyze-form');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const url = document.getElementById('analyze-url').value.trim();
        if (!url) return;

        const btn = document.getElementById('analyze-btn');
        const loading = document.getElementById('analyze-loading');
        const results = document.getElementById('analyze-results');

        btn.disabled = true;
        loading.style.display = 'flex';
        results.style.display = 'none';

        try {
            const res = await fetch('/api/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url })
            });

            const data = await res.json();

            if (!res.ok || data.error) {
                alert(data.error || 'حصل خطأ أثناء الفحص');
                return;
            }

            lastReport = data;
            renderResults(data);
            results.style.display = 'block';

        } catch (err) {
            console.error(err);
            alert('حدث خطأ أثناء الاتصال بالسيرفر');
        } finally {
            btn.disabled = false;
            loading.style.display = 'none';
        }
    });

    setupDriveConnection();
    setupCopyButtons();
});

function renderResults(data) {
    document.getElementById('result-performance').textContent =
        data.speed?.performanceScore != null ? data.speed.performanceScore + '/100' : '—';
    document.getElementById('result-seo').textContent =
        data.speed?.seoScore != null ? data.speed.seoScore + '/100' : '—';
    document.getElementById('result-accessibility').textContent =
        data.speed?.accessibilityScore != null ? data.speed.accessibilityScore + '/100' : '—';
    document.getElementById('result-safety').textContent =
        data.safety ? (data.safety.isSafe ? '✅ آمن' : '⚠️ يوجد تهديد') : '—';

    const prioritiesList = document.getElementById('result-priorities');
    prioritiesList.innerHTML = (data.aiRecommendations?.topPriorities || [])
        .map(p => `<li>${escapeHtml(p)}</li>`).join('');

    document.getElementById('result-meta').textContent =
        data.aiRecommendations?.suggestedMetaDescription || 'لا توجد توصية';

    document.getElementById('result-schema').textContent =
        data.aiRecommendations?.schemaMarkup || 'لا يوجد كود مقترح';
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ============================================================
// نسخ الأكواد بضغطة زرار
// ============================================================
function setupCopyButtons() {
    document.querySelectorAll('.copy-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const targetId = btn.getAttribute('data-copy-target');
            const text = document.getElementById(targetId).textContent;
            navigator.clipboard.writeText(text).then(() => {
                const original = btn.textContent;
                btn.textContent = 'تم النسخ ✓';
                setTimeout(() => { btn.textContent = original; }, 1500);
            });
        });
    });
}

// ============================================================
// ربط Drive + الحفظ
// ============================================================
function setupDriveConnection() {
    const connectBtn = document.getElementById('connect-drive-btn');
    const saveBtn = document.getElementById('save-report-btn');

    const isDriveConnected = localStorage.getItem('driveConnected') === 'true';
    toggleDriveUI(isDriveConnected);

    if (connectBtn) {
        connectBtn.addEventListener('click', () => {
            const user = getCurrentUser();
            if (!user || !user.email) {
                alert('لازم تسجل دخول الأول');
                window.location.href = 'login.html';
                return;
            }

            if (typeof google === 'undefined' || !google.accounts?.oauth2) {
                alert('مكتبة جوجل لسه بتحمّل، حاول تاني بعد ثانية');
                return;
            }

            driveCodeClient = google.accounts.oauth2.initCodeClient({
                client_id: GOOGLE_CLIENT_ID,
                scope: DRIVE_SCOPES,
                ux_mode: 'popup',
                callback: async (response) => {
                    if (!response.code) {
                        alert('لم تتم الموافقة على ربط Drive');
                        return;
                    }
                    await sendCodeToServer(response.code, user.email);
                }
            });

            driveCodeClient.requestCode();
        });
    }

    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            const user = getCurrentUser();
            if (!user || !lastReport) return;

            saveBtn.disabled = true;
            saveBtn.textContent = 'جاري الحفظ...';

            try {
                const res = await fetch('/api/save-report', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: user.email, report: lastReport })
                });

                const data = await res.json();

                if (!res.ok || data.error) {
                    alert(data.error || 'فشل حفظ النتيجة');
                    return;
                }

                const link = document.getElementById('sheet-link');
                link.href = data.reportUrl;
                link.style.display = 'inline-block';
                alert('تم الحفظ بنجاح!');

            } catch (err) {
                console.error(err);
                alert('حدث خطأ أثناء الحفظ');
            } finally {
                saveBtn.disabled = false;
                saveBtn.textContent = 'احفظ النتيجة في Drive';
            }
        });
    }
}

async function sendCodeToServer(code, email) {
    try {
        const res = await fetch('/api/connect-drive', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, email, redirectUri: 'postmessage' })
        });

        const data = await res.json();

        if (!res.ok || data.error) {
            alert(data.error || 'فشل ربط Drive');
            return;
        }

        localStorage.setItem('driveConnected', 'true');
        toggleDriveUI(true);
        alert('تم ربط Drive بنجاح!');

    } catch (err) {
        console.error(err);
        alert('حدث خطأ أثناء ربط Drive');
    }
}

function toggleDriveUI(connected) {
    const notConnected = document.getElementById('drive-not-connected');
    const connectedBox = document.getElementById('drive-connected');
    if (!notConnected || !connectedBox) return;

    notConnected.style.display = connected ? 'none' : 'block';
    connectedBox.style.display = connected ? 'block' : 'none';
}
