/**
 * منطق الصفحة الرئيسية (Dashboard): الشريط الجانبي + شبكة الأدوات + حالة المستخدم
 * ملاحظة: ده منفصل تماماً عن script.js بتاع صفحات تسجيل الدخول، ومحدش بيلمس التاني
 */

const ICONS = {
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9a1 1 0 0 0 1 1H9a1 1 0 0 0 1-1v-4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v4a1 1 0 0 0 1 1h2.5a1 1 0 0 0 1-1v-9"/></svg>',
    scan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><path d="M4 12h16"/></svg>',
    languages: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h9M7.5 3.5v3M4 15c2.5 0 6-1.2 7.5-4.5M5.5 9.5c1 2.5 4 5 8 6"/><path d="M13 20l4-8 4 8M14.5 17h5"/></svg>',
    presentation: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 4h18M12 16v4m-3 0h6"/><rect x="4" y="4" width="16" height="12" rx="1"/><path d="M8.5 12.5 11 9l2 2 2.5-3.5"/></svg>',
    video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="6" width="12" height="12" rx="1.5"/><path d="m15 10 6-3v10l-6-3"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.5"/><path d="M12 8v4.5l3 2"/></svg>',
    menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3.5 6.5h17M3.5 12h17M3.5 17.5h17"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 5l14 14M19 5 5 19"/></svg>',
    logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 4H6a1.5 1.5 0 0 0-1.5 1.5v13A1.5 1.5 0 0 0 6 20h3M15 16l4-4-4-4M19 12H9"/></svg>'
};

function icon(name) {
    return ICONS[name] || ICONS.scan;
}

// ------------------------------------------------------------------
// 1. بناء الشريط الجانبي وشبكة الأدوات من tools-config.js
// ------------------------------------------------------------------
function renderSidebarLinks() {
    const list = document.getElementById('sidebar-tools-list');
    if (!list || typeof TOOLS === 'undefined') return;

    const currentPage = window.location.pathname.split('/').pop() || 'index.html';

    list.innerHTML = TOOLS.map(tool => {
        const isActive = currentPage === tool.route;
        const isSoon = tool.status !== 'active';
        const href = isSoon ? '#' : tool.route;

        return `
            <a href="${href}"
               class="sidebar-link ${isActive ? 'is-active' : ''} ${isSoon ? 'is-soon' : ''}"
               ${isSoon ? 'onclick="return false;" aria-disabled="true"' : ''}>
                <span class="sidebar-link-icon">${icon(tool.icon)}</span>
                <span class="sidebar-link-text">${tool.name}</span>
                ${isSoon ? '<span class="soon-badge">قريباً</span>' : ''}
            </a>
        `;
    }).join('');
}

function renderToolsGrid() {
    const grid = document.getElementById('tools-grid');
    if (!grid || typeof TOOLS === 'undefined') return;

    grid.innerHTML = TOOLS.map(tool => {
        const isSoon = tool.status !== 'active';
        const cardTag = isSoon ? 'div' : 'a';
        const hrefAttr = isSoon ? '' : `href="${tool.route}"`;

        return `
            <${cardTag} ${hrefAttr} class="tool-card ${isSoon ? 'is-soon' : ''}">
                <div class="tool-card-icon">${icon(tool.icon)}</div>
                <h3 class="tool-card-title">${tool.name}</h3>
                <p class="tool-card-desc">${tool.description}</p>
                <div class="tool-card-footer">
                    <code class="tool-route">~/${tool.route}</code>
                    ${isSoon ? '<span class="soon-badge">' + icon('clock') + ' قريباً</span>' : '<span class="tool-go">افتح ←</span>'}
                </div>
            </${cardTag}>
        `;
    }).join('');
}

// ------------------------------------------------------------------
// 2. حالة تسجيل الدخول في الشريط الجانبي
// ------------------------------------------------------------------
function renderUserSection() {
    const box = document.getElementById('sidebar-user-box');
    if (!box) return;

    let user = null;
    try {
        user = JSON.parse(localStorage.getItem('user'));
    } catch {
        user = null;
    }

    if (user && user.email) {
        const initial = (user.name || user.email).trim().charAt(0).toUpperCase();
        box.innerHTML = `
            <div class="user-chip">
                ${user.picture
                    ? `<img src="${user.picture}" alt="" class="user-avatar">`
                    : `<span class="user-avatar user-avatar--fallback">${initial}</span>`}
                <div class="user-chip-text">
                    <span class="user-chip-name">${user.name || 'مستخدم'}</span>
                    <span class="user-chip-email">${user.email}</span>
                </div>
            </div>
            <button type="button" id="logout-btn" class="logout-btn">
                ${icon('logout')} تسجيل خروج
            </button>
        `;

        document.getElementById('logout-btn').addEventListener('click', () => {
            localStorage.removeItem('user');
            window.location.reload();
        });
    } else {
        box.innerHTML = `
            <a href="login.html" class="sidebar-login-btn">تسجيل الدخول</a>
        `;
    }
}

// ------------------------------------------------------------------
// 3. فتح/قفل الشريط الجانبي على الموبايل
// ------------------------------------------------------------------
function setupMobileToggle() {
    const toggleBtn = document.getElementById('mobile-menu-toggle');
    const sidebar = document.getElementById('app-sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    if (!toggleBtn || !sidebar || !overlay) return;

    function closeSidebar() {
        sidebar.classList.remove('is-open');
        overlay.classList.remove('is-visible');
    }

    toggleBtn.addEventListener('click', () => {
        sidebar.classList.toggle('is-open');
        overlay.classList.toggle('is-visible');
    });

    overlay.addEventListener('click', closeSidebar);
}

function renderToolsCount() {
    const badge = document.getElementById('tools-count-badge');
    if (!badge || typeof TOOLS === 'undefined') return;
    const activeCount = TOOLS.filter(t => t.status === 'active').length;
    badge.textContent = `${activeCount} / ${TOOLS.length} شغّالة`;
}

document.addEventListener('DOMContentLoaded', () => {
    renderSidebarLinks();
    renderToolsGrid();
    renderToolsCount();
    renderUserSection();
    setupMobileToggle();
});
