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
    setupFixesFilter();
});

const SEVERITY_LABELS = {
    critical: 'حرجة',
    high: 'مهمة',
    medium: 'بسيطة'
};

let currentFixes = [];
let activeFilter = 'all';

function renderResults(data) {
    renderScoreGauges(data);
    currentFixes = data.aiRecommendations?.fixes || [];
    renderFixes();
    renderSummaryStrip();

    document.getElementById('result-meta').textContent =
        data.aiRecommendations?.suggestedMetaDescription || 'لا توجد توصية';

    document.getElementById('result-schema').textContent =
        data.aiRecommendations?.schemaMarkup || 'لا يوجد كود مقترح';
}

// ============================================================
// دوائر تقدّم النتائج (SVG)
// ============================================================
function renderScoreGauges(data) {
    const container = document.getElementById('score-gauges');

    const gauges = [
        { label: 'الأداء', value: data.speed?.performanceScore ?? null },
        { label: 'الأرشفة (SEO)', value: data.speed?.seoScore ?? null },
        { label: 'إمكانية الوصول', value: data.speed?.accessibilityScore ?? null },
        {
            label: 'الأمان',
            value: data.safety ? (data.safety.isSafe ? 100 : 0) : null,
            customText: data.safety ? (data.safety.isSafe ? 'آمن' : 'يوجد تهديد') : null
        }
    ];

    container.innerHTML = gauges.map(g => buildGaugeSVG(g.label, g.value, g.customText)).join('');
}

function buildGaugeSVG(label, value, customText) {
    const radius = 42;
    const circumference = 2 * Math.PI * radius;
    const safeValue = value ?? 0;
    const offset = circumference * (1 - safeValue / 100);
    const colorClass = value === null ? 'gauge-unknown'
        : value >= 90 ? 'gauge-good'
        : value >= 50 ? 'gauge-mid'
        : 'gauge-bad';

    return `
        <div class="gauge-item">
            <div class="gauge-circle-wrap">
                <svg viewBox="0 0 100 100" class="gauge-svg ${colorClass}">
                    <circle cx="50" cy="50" r="${radius}" class="gauge-track" />
                    <circle cx="50" cy="50" r="${radius}" class="gauge-progress"
                        stroke-dasharray="${circumference}"
                        stroke-dashoffset="${offset}" />
                </svg>
                <div class="gauge-value">${customText || (value != null ? value : '—')}</div>
            </div>
            <div class="gauge-label">${label}</div>
        </div>
    `;
}

// ============================================================
// شريط الملخص العلوي
// ============================================================
function renderSummaryStrip() {
    const strip = document.getElementById('report-summary-strip');
    const counts = { critical: 0, high: 0, medium: 0 };

    currentFixes.forEach(f => {
        const sev = f.severity && counts.hasOwnProperty(f.severity) ? f.severity : 'medium';
        counts[sev]++;
    });

    if (currentFixes.length === 0) {
        strip.innerHTML = `<div class="summary-pill summary-pill--good">✓ الموقع في حالة ممتازة، مفيش مشاكل كبيرة</div>`;
        return;
    }

    strip.innerHTML = `
        ${counts.critical > 0 ? `<div class="summary-pill summary-pill--critical">${counts.critical} مشكلة حرجة</div>` : ''}
        ${counts.high > 0 ? `<div class="summary-pill summary-pill--high">${counts.high} مشكلة مهمة</div>` : ''}
        ${counts.medium > 0 ? `<div class="summary-pill summary-pill--medium">${counts.medium} ملاحظة بسيطة</div>` : ''}
    `;
}

// ============================================================
// كروت الحلول (المشكلة فوق، الحل تحتها)
// ============================================================
function renderFixes() {
    const container = document.getElementById('result-fixes');
    const countLabel = document.getElementById('fixes-count');

    const visibleFixes = activeFilter === 'all'
        ? currentFixes
        : currentFixes.filter(f => (f.severity || 'medium') === activeFilter);

    countLabel.textContent = currentFixes.length > 0
        ? `الحلول المقترحة (${currentFixes.length})`
        : 'الحلول المقترحة';

    if (currentFixes.length === 0) {
        container.innerHTML = '<p class="fixes-empty">مفيش مشاكل كبيرة، الموقع في حالة كويسة 👍</p>';
        return;
    }

    if (visibleFixes.length === 0) {
        container.innerHTML = '<p class="fixes-empty">مفيش مشاكل في التصنيف ده</p>';
        return;
    }

    container.innerHTML = visibleFixes.map((fix, index) => {
        const codeBlockId = `fix-code-${index}`;
        const severity = fix.severity && SEVERITY_LABELS[fix.severity] ? fix.severity : 'medium';

        return `
            <div class="fix-card fix-card--${severity}">
                <div class="fix-severity-bar"></div>
                <div class="fix-card-body">
                    <div class="fix-card-header">
                        <span class="fix-severity-badge fix-severity-badge--${severity}">${SEVERITY_LABELS[severity]}</span>
                        ${fix.impact ? `<span class="fix-impact">${escapeHtml(fix.impact)}</span>` : ''}
                    </div>

                    <div class="fix-section">
                        <span class="fix-section-label">المشكلة</span>
                        <h4 class="fix-title">${escapeHtml(fix.title || 'مشكلة')}</h4>
                    </div>

                    <div class="fix-section">
                        <span class="fix-section-label fix-section-label--solution">الحل المقترح</span>
                        <p class="fix-instructions">${escapeHtml(fix.instructions || '')}</p>
                    </div>

                    ${fix.codeExample ? `
                        <div class="fix-code-wrap">
                            <button class="copy-btn" data-copy-target="${codeBlockId}">نسخ الكود</button>
                            <pre id="${codeBlockId}" class="result-code result-code--block">${escapeHtml(fix.codeExample)}</pre>
                        </div>
                    ` : ''}
                </div>
            </div>
        `;
    }).join('');

    setupCopyButtons();
}

function setupFixesFilter() {
    const filterBar = document.getElementById('fixes-filter');
    if (!filterBar) return;

    filterBar.addEventListener('click', (e) => {
        const btn = e.target.closest('.filter-chip');
        if (!btn) return;

        filterBar.querySelectorAll('.filter-chip').forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        activeFilter = btn.getAttribute('data-filter');
        renderFixes();
    });
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
