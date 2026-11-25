window.onerror = function(msg, url, line, col) {
    fetch('/api/client_log', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({msg: String(msg), line: line, col: col})
    }).catch(() => {});
};

let currentProjectId = null;
let currentProjectData = null;
let editingProjectMeta = false;
let editingItemId = null;
let focusedItemId = null;
let editingInvoiceId = null;
let editingOfferId = null;
let editingMetaKey = null;
let addingCellKey = null;

function showSaveNotice(msg) {
    let el = document.getElementById('saveToast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'saveToast';
        el.style.cssText = 'position:fixed;top:15px;right:20px;background:#16a34a;color:#fff;padding:10px 18px;border-radius:6px;font-weight:bold;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,0.2);z-index:9999;transition:opacity 0.3s;';
        document.body.appendChild(el);
    }
    el.innerText = msg;
    el.style.opacity = '1';
    clearTimeout(el._timer);
    el._timer = setTimeout(() => { el.style.opacity = '0'; }, 3000);
}

function switchTab(tabName, btn) {
    document.querySelectorAll('.view').forEach(v => {
        v.classList.remove('active');
        v.style.display = 'none';
    });
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    const target = document.getElementById('view-' + tabName);
    if (target) {
        target.classList.add('active');
        target.style.display = 'block';
    }
    if (btn && btn.classList) btn.classList.add('active');
    if (tabName === 'projects') loadProjects();
    if (tabName === 'kanban') loadKanban();
    if (tabName === 'received') loadReceived();
    if (tabName === 'archive') loadArchiveProjects();
}

function openProjectModal() { document.getElementById('projectModal').style.display = 'flex'; }
function closeModal(id) { document.getElementById(id).style.display = 'none'; }

async function browseFolder() {
    const res = await fetch('/api/select_folder');
    const data = await res.json();
    if (data.folder) document.getElementById('newProjFolder').value = data.folder;
}

let draggedProjId = null;

function getProjPriority(p) {
    if (!p.stats) return 3;
    const inWork = (p.stats.accounting || 0) + (p.stats.paid || 0) + (p.stats.transit || 0);
    const isRec = (p.stats.received || 0) > 0;
    if (isRec && inWork === 0) return 1; // Полученные сверху
    if (inWork > 0) return 2;            // В пути / в работе под ними
    return 3;                            // Новые ниже
}

async function saveManualProjectOrder() {
    const ids = Array.from(document.querySelectorAll('#projectList .proj-item')).map(el => el.dataset.id);
    await fetch('/api/projects/reorder', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({order: ids})
    });
    showSaveNotice('✔ Порядок проектов сохранён!');
}

async function loadProjects() {
    const res = await fetch('/api/projects?archived=0');
    const list = await res.json();

    // Если пользователь уже задал ручной порядок (sort_order != null) — соблюдаем его;
    // иначе ставим: 1. Полученные -> 2. В пути -> 3. Новые
    list.sort((a, b) => {
        const hasA = a.sort_order !== null && a.sort_order !== undefined;
        const hasB = b.sort_order !== null && b.sort_order !== undefined;
        if (hasA && hasB) return a.sort_order - b.sort_order;
        if (hasA && !hasB) return -1;
        if (!hasA && hasB) return 1;
        const pa = getProjPriority(a), pb = getProjPriority(b);
        if (pa !== pb) return pa - pb;
        return b.id - a.id;
    });

    const container = document.getElementById('projectList');
    container.innerHTML = '';
    list.forEach(p => {
        const div = document.createElement('div');
        div.dataset.id = p.id;
        div.draggable = true;

        div.ondragstart = (e) => {
            draggedProjId = p.id;
            div.style.opacity = '0.5';
            e.dataTransfer.effectAllowed = 'move';
        };
        div.ondragend = () => { div.style.opacity = '1'; };
        div.ondragover = (e) => {
            e.preventDefault();
            div.style.borderTop = '2px solid #2563eb';
        };
        div.ondragleave = () => { div.style.borderTop = ''; };
        div.ondrop = async (e) => {
            e.preventDefault();
            div.style.borderTop = '';
            if (!draggedProjId || draggedProjId === p.id) return;
            const draggedEl = container.querySelector(`.proj-item[data-id="${draggedProjId}"]`);
            if (draggedEl) {
                container.insertBefore(draggedEl, div);
                await saveManualProjectOrder();
            }
        };

        let statusClass = 'proj-new';
        if (p.stats) {
            const inWork = (p.stats.accounting || 0) + (p.stats.paid || 0) + (p.stats.transit || 0);
            const isRec = (p.stats.received || 0) > 0;
            if (inWork > 0) statusClass = 'proj-work';
            else if (isRec) statusClass = 'proj-done';
        }
        div.className = `proj-item ${statusClass}` + (p.id === currentProjectId ? ' active' : '');
        let b = '';
        if (p.stats) {
            if (p.stats.accounting) b += `<span class="badge-st" style="background:#fef08a;color:#854d0e;">На оплату: ${p.stats.accounting}</span>`;
            if (p.stats.paid) b += `<span class="badge-st" style="background:#bae6fd;color:#075985;">Оплачено: ${p.stats.paid}</span>`;
            if (p.stats.transit) b += `<span class="badge-st" style="background:#fed7aa;color:#9a3412;">В пути: ${p.stats.transit}</span>`;
            if (p.stats.received) b += `<span class="badge-st" style="background:#bbf7d0;color:#166534;">Получено: ${p.stats.received}</span>`;
        }
        div.innerHTML = `<div style="font-size:12px;"><span style="color:#94a3b8;cursor:grab;margin-right:4px;" title="Перетащите для изменения порядка">⋮⋮</span>${p.name}</div><div style="font-size:11px;color:#64748b;">📅 ${p.created_at || ''}</div><div>${b}</div>`;
        div.onclick = () => selectProject(p.id);
        container.appendChild(div);
    });
}

async function createProject() {
    const name = document.getElementById('newProjName').value.trim();
    const folder_path = document.getElementById('newProjFolder').value.trim();
    const items = document.getElementById('newProjItems').value.trim();
    if (!name) { alert('Введите название проекта!'); return; }
    const res = await fetch('/api/projects', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name, folder_path, items})
    });
    const data = await res.json();
    document.getElementById('newProjName').value = '';
    document.getElementById('newProjFolder').value = '';
    document.getElementById('newProjItems').value = '';
    closeModal('projectModal');
    await loadProjects();
    selectProject(data.id);
}

async function selectProject(id) {
    const sc = document.querySelector('.table-scroll');
    const prevLeft = sc ? sc.scrollLeft : 0;
    const prevTop = sc ? sc.scrollTop : 0;
    currentProjectId = id;
    loadProjects();
    const res = await fetch(`/api/projects/${id}`);
    currentProjectData = await res.json();
    renderComparisonTable();
    const newSc = document.querySelector('.table-scroll');
    if (newSc) { newSc.scrollLeft = prevLeft; newSc.scrollTop = prevTop; }
}

function keepScrollAndRender() {
    const sc = document.querySelector('.table-scroll');
    const l = sc ? sc.scrollLeft : 0, t = sc ? sc.scrollTop : 0;
    renderComparisonTable();
    const nsc = document.querySelector('.table-scroll');
    if (nsc) { nsc.scrollLeft = l; nsc.scrollTop = t; }
}

function extractNum(val) {
    if (!val) return 0;
    const m = String(val).replace(',', '.').match(/[0-9]+(?:\.[0-9]+)?/);
    return m ? parseFloat(m) : 0;
}

let draggedInvId = null;

async function saveInvoiceColumnsOrder(orderedIds) {
    await fetch('/api/invoices/reorder', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({order: orderedIds})
    });
    await selectProject(currentProjectId);
    showSaveNotice('✔ Порядок счетов сохранён!');
}

async function sortInvoicesByPriceAsc() {
    if (!currentProjectData || !currentProjectData.invoices.length) return;
    const offers = currentProjectData.offers;
    const invWithSum = currentProjectData.invoices.map(inv => {
        const sum = offers.filter(o => o.invoice_id === inv.id).reduce((a, o) => a + (parseFloat(o.price) || 0), 0);
        return { id: inv.id, sum: sum > 0 ? sum : Infinity };
    });
    invWithSum.sort((a, b) => a.sum - b.sum);
    await saveInvoiceColumnsOrder(invWithSum.map(x => x.id));
}

async function moveInvoiceCol(invId, dir) {
    const ids = currentProjectData.invoices.map(x => x.id);
    const idx = ids.indexOf(invId);
    const targetIdx = idx + dir;
    if (idx === -1 || targetIdx < 0 || targetIdx >= ids.length) return;
    const tmp = ids.at(idx);
    ids.splice(idx, 1);
    ids.splice(targetIdx, 0, tmp);
    await saveInvoiceColumnsOrder(ids);
}

function onInvDragStart(e, invId) {
    draggedInvId = invId;
    e.dataTransfer.effectAllowed = 'move';
}

async function onInvDrop(e, targetInvId) {
    e.preventDefault();
    if (!draggedInvId || draggedInvId === targetInvId) return;
    const ids = currentProjectData.invoices.map(x => x.id);
    const fromIdx = ids.indexOf(draggedInvId);
    const toIdx = ids.indexOf(targetInvId);
    if (fromIdx === -1 || toIdx === -1) return;
    ids.splice(fromIdx, 1);
    ids.splice(toIdx, 0, draggedInvId);
    draggedInvId = null;
    await saveInvoiceColumnsOrder(ids);
}

function renderComparisonTable() {
    const ws = document.getElementById('projectWorkspace');
    const p = currentProjectData.project;
    const items = currentProjectData.items;
    const invoices = currentProjectData.invoices;
    const offers = currentProjectData.offers;
    const fList = currentProjectData.folder_files || [];

    let filesHtml = fList.length ? `<div style="margin-top:8px;padding:6px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:5px;"><div style="font-size:11px;font-weight:bold;color:#475569;margin-bottom:4px;">📂 Файлы в проекте (${fList.length}):</div><div style="display:flex;flex-wrap:wrap;gap:5px;">` + fList.map(fn => `<a href="/api/projects/${p.id}/folder_file/${encodeURIComponent(fn)}" target="_blank" style="background:#fff;padding:2px 6px;border:1px solid #cbd5e1;border-radius:3px;text-decoration:none;color:#1e293b;font-size:11px;">📄 ${fn}</a>`).join('') + `</div></div>` : '';

    const projHeader = editingProjectMeta
        ? `<div style="display:flex;gap:5px;flex-wrap:wrap;"><input id="editProjNameInp" value="${p.name}" style="padding:3px;font-size:13px;width:240px;"><input id="editProjFolderInp" value="${p.folder_path}" style="padding:3px;font-size:12px;width:280px;"><button class="btn-green" style="padding:3px 8px;font-size:11px;" onclick="saveProjectMeta(${p.id})">💾 Сохранить</button><button class="btn-gray" style="padding:3px 8px;font-size:11px;" onclick="editingProjectMeta=false;renderComparisonTable()">✖</button></div>`
        : `<h3 style="margin:0;font-size:16px;">${p.name} <button type="button" onclick="editingProjectMeta=true;renderComparisonTable()" style="background:transparent;color:#475569;border:1px solid #cbd5e1;padding:1px 5px;font-size:11px;">✏️</button></h3><small style="color:#64748b;font-size:11px;">Папка: ${p.folder_path}</small>`;

    let html = `<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;"><div>${projHeader}</div><div style="display:flex;gap:8px;flex-shrink:0;"><input type="file" id="importExcelInput" accept=".xlsx,.xlsm,.xls,.ods" style="display:none" onchange="importComparisonTable()"><button style="background:#0284c7;" onclick="document.getElementById('importExcelInput').click()">📥 Импорт таблицы</button><button style="background:#7c3aed;" onclick="sortInvoicesByPriceAsc()" title="Выстроить счета слева направо от самого дешёвого к дорогому">📊 По возрастанию цены</button><button onclick="openInvoiceModal()">+ Добавить счёт</button><button class="btn-green" onclick="sendSelectedToWork()">✔ В работу</button><button class="btn-gray" onclick="archiveProject(${p.id}, 1)">📦 В архив</button></div></div>${filesHtml}<div style="font-size:11px;margin-top:6px;color:#475569;">Подсветка: <span style="background:#dcfce7;padding:1px 6px;border:1px solid #86efac;">Самая дешёвая цена</span> <span style="background:#dbeafe;padding:1px 6px;border:1px solid #93c5fd;">Выгоднее за м / кг</span> <span style="background:#ffe4e6;padding:1px 6px;border:1px solid #fda4af;">Самая дорогая</span></div><div class="table-scroll"><table><thead><tr><th class="col-item">Заказываемый материал (Заявка) <button type="button" onclick="addNewItemRow()" style="float:right;background:#2563eb;color:#fff;padding:2px 6px;font-size:10px;">+ Строка</button></th>`;

    invoices.forEach(inv => {
        const invOffers = offers.filter(o => o.invoice_id === inv.id && !o.kanban_status && (o.price > 0 || o.kg || o.meters));
        const allSelected = invOffers.length > 0 && invOffers.every(o => o.selected === 1);
        const btnText = allSelected ? '☑ Снять весь счёт' : '☐ Выбрать весь счёт';
        const btnStyle = allSelected ? 'background:#16a34a;color:#fff;' : 'background:#e2e8f0;color:#1e293b;';
        const selectAllBtn = invOffers.length > 0 ? `<div style="margin-top:5px;"><button type="button" style="${btnStyle}padding:3px 7px;font-size:11px;width:100%;" onclick="toggleInvoiceAll(${inv.id}, ${!allSelected})">${btnText}</button></div>` : '';
        let fl = inv.filename
            ? `<div style="margin-top:4px;padding:3px 5px;background:#f8fafc;border:1px solid #cbd5e1;border-radius:4px;"><div style="font-size:10px;color:#475569;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${inv.filename}">${inv.filename}</div><div style="display:flex;gap:4px;margin-top:3px;"><a href="/api/invoice_file/${inv.id}" target="_blank" style="flex:1;text-align:center;background:#2563eb;color:#fff;padding:2px 4px;border-radius:3px;text-decoration:none;font-size:10px;">📄 Открыть</a><button type="button" onclick="promptAttachFile(${inv.id})" style="background:#e2e8f0;color:#1e293b;padding:2px 5px;font-size:10px;">🔄</button><button type="button" onclick="detachInvoiceFile(${inv.id})" style="background:#fee2e2;color:#dc2626;padding:2px 5px;font-size:10px;">✖</button></div></div>`
            : `<div style="margin-top:4px;"><button type="button" onclick="promptAttachFile(${inv.id})" style="background:#f1f5f9;color:#0284c7;border:1px dashed #0284c7;padding:3px 6px;font-size:11px;width:100%;">📎 Выбрать счёт</button></div>`;

        if (editingInvoiceId === inv.id) {
            html += `<th class="col-sup" style="background:#fffbeb;"><input id="editInvSup_${inv.id}" value="${inv.supplier}" placeholder="Поставщик" style="padding:2px;font-size:11px;margin-bottom:3px;"><input id="editInvNum_${inv.id}" value="${inv.invoice_num || ''}" placeholder="Номер счёта" style="padding:2px;font-size:11px;margin-bottom:3px;"><div style="display:flex;gap:3px;"><button class="btn-green" style="padding:2px 6px;font-size:10px;flex:1;" onclick="saveInvoiceHeader(${inv.id})">💾</button><button class="btn-gray" style="padding:2px 6px;font-size:10px;" onclick="editingInvoiceId=null;keepScrollAndRender()">✖</button></div></th>`;
        } else {
            const invEditBtn = `<span style="float:right;display:flex;gap:2px;"><button type="button" onclick="moveInvoiceCol(${inv.id}, -1)" style="background:transparent;color:#475569;border:1px solid #cbd5e1;padding:0 4px;font-size:10px;" title="Сдвинуть столбец влево">◀</button><button type="button" onclick="moveInvoiceCol(${inv.id}, 1)" style="background:transparent;color:#475569;border:1px solid #cbd5e1;padding:0 4px;font-size:10px;" title="Сдвинуть столбец вправо">▶</button><button type="button" onclick="editingInvoiceId=${inv.id};keepScrollAndRender()" style="background:transparent;color:#475569;border:1px solid #cbd5e1;padding:0 4px;font-size:10px;">✏️</button><button type="button" onclick="deleteInvoiceCol(${inv.id})" style="background:transparent;color:#dc2626;border:1px solid #fecaca;padding:0 4px;font-size:10px;">🗑</button></span>`;
            html += `<th class="col-sup" draggable="true" ondragstart="onInvDragStart(event, ${inv.id})" ondragover="event.preventDefault()" ondrop="onInvDrop(event, ${inv.id})" style="cursor:grab;" title="Перетащите за шапку влево или вправо">${invEditBtn}<div>${inv.supplier}</div><div style="font-weight:normal;font-size:11px;color:#475569;">${inv.invoice_num || ''}</div>${fl}${selectAllBtn}</th>`;
        }
    });
    html += `</tr></thead><tbody>`;

    items.forEach(item => {
        const rec = offers.find(o => o.item_id === item.id && o.received_color);
        const rowBg = rec ? rec.received_color : '';
        const lowName = item.name.toLowerCase();
        const isService = lowName.includes('порезка') || lowName.includes('раскрой') || lowName.includes('доставка');
        const rowOffers = offers.filter(o => o.item_id === item.id && parseFloat(o.price) > 0);
        let minTotal = Infinity, maxTotal = -Infinity, minUnitM = Infinity, minUnitKg = Infinity;
        let countM = 0, countKg = 0;

        if (!isService && rowOffers.length > 1) {
            rowOffers.forEach(o => {
                const pr = parseFloat(o.price);
                if (pr < minTotal) minTotal = pr;
                if (pr > maxTotal) maxTotal = pr;
                const mVal = extractNum(o.meters), kgVal = extractNum(o.kg);
                if (mVal > 0) { countM++; if ((pr / mVal) < minUnitM) minUnitM = pr / mVal; }
                if (kgVal > 0) { countKg++; if ((pr / kgVal) < minUnitKg) minUnitKg = pr / kgVal; }
            });
            if (countM < 2) minUnitM = Infinity;
            if (countKg < 2) minUnitKg = Infinity;
        }

        if (editingItemId === item.id) {
            html += `<tr><td class="col-item ${rowBg}" style="background:#fffbeb;"><textarea id="editItemInp_${item.id}" rows="2" style="width:100%;font-size:12px;padding:3px;">${item.name}</textarea><div style="display:flex;gap:4px;margin-top:3px;"><button class="btn-green" style="padding:2px 6px;font-size:11px;flex:1;" onclick="saveProjectItemName(${item.id})">💾 Сохранить</button><button class="btn-gray" style="padding:2px 6px;font-size:11px;" onclick="editingItemId=null;keepScrollAndRender()">✖</button></div></td>`;
        } else {
            const itemBtns = `<span style="float:right;display:flex;gap:2px;margin-left:5px;"><button type="button" onclick="editingItemId=${item.id};keepScrollAndRender()" style="background:transparent;color:#475569;border:1px solid #cbd5e1;padding:1px 4px;font-size:10px;">✏️</button><button type="button" onclick="deleteProjectItem(${item.id})" style="background:transparent;color:#dc2626;border:1px solid #fecaca;padding:1px 4px;font-size:10px;">🗑</button></span>`;
            const fCls = (focusedItemId === 'item_' + item.id) ? "row-focused" : "";
            html += `<tr class="${fCls}" onclick="focusTableRow('item_${item.id}', this)"><td class="col-item ${rowBg}">${itemBtns}<b>${item.name}</b></td>`;
        }

        invoices.forEach(inv => {
            const off = offers.find(o => o.invoice_id === inv.id && o.item_id === item.id);
            if (off && (off.price > 0 || off.kg || off.meters)) {
                if (editingOfferId === off.id) {
                    html += `<td class="col-sup offer-cell" style="background:#fffbeb;border:2px solid #f59e0b;"><div style="font-size:11px;font-weight:bold;margin-bottom:3px;">Редактирование:</div><input type="number" step="0.01" id="edit_pr_${off.id}" value="${off.price}" style="padding:3px;margin-bottom:3px;font-size:12px;"><div style="display:flex;gap:4px;margin-bottom:4px;"><input type="text" id="edit_kg_${off.id}" value="${off.kg || ''}" placeholder="Вес" style="padding:3px;font-size:11px;"><input type="text" id="edit_m_${off.id}" value="${off.meters || ''}" placeholder="Метры" style="padding:3px;font-size:11px;"></div><div style="display:flex;gap:4px;"><button type="button" class="btn-green" style="padding:3px 7px;font-size:11px;flex:1;" onclick="event.stopPropagation();saveEditedOffer(${off.id})">💾 Сохранить</button><button type="button" class="btn-gray" style="padding:3px 7px;font-size:11px;" onclick="editingOfferId=null;keepScrollAndRender()">✖</button></div></td>`;
                } else {
                    const pr = parseFloat(off.price) || 0, mVal = extractNum(off.meters), kgVal = extractNum(off.kg);
                    let cellBg = '', unitHint = '';
                    if (mVal > 0 && pr > 0) unitHint += ` (${(pr / mVal).toFixed(0)} р/м)`;
                    else if (kgVal > 0 && pr > 0) unitHint += ` (${(pr / kgVal).toFixed(0)} р/кг)`;
                    if (!isService && rowOffers.length > 1 && pr > 0) {
                        const isBestTotal = Math.abs(pr - minTotal) < 0.01;
                        const isWorstTotal = Math.abs(pr - maxTotal) < 0.01 && maxTotal > minTotal;
                        const isBestUnit = (mVal > 0 && Math.abs((pr / mVal) - minUnitM) < 0.01) || (kgVal > 0 && Math.abs((pr / kgVal) - minUnitKg) < 0.01);
                        if (isBestTotal) cellBg = 'price-best';
                        else if (isBestUnit) cellBg = 'price-unit-best';
                        else if (isWorstTotal) cellBg = 'price-worst';
                    }
                    const st = off.kanban_status ? `<span style="color:#15803d;font-weight:bold;font-size:11px;"> [В работе]</span>` : '';
                    const editBtn = `<button type="button" onclick="event.stopPropagation();editingOfferId=${off.id};keepScrollAndRender()" style="float:right;background:transparent;color:#475569;border:1px solid #cbd5e1;padding:1px 5px;font-size:11px;">✏️</button>`;
                    html += `<td class="col-sup offer-cell ${cellBg} ${off.selected ? 'offer-selected' : ''}">${editBtn}<label style="cursor:pointer;font-weight:bold;font-size:11px;"><input type="checkbox" ${off.selected ? 'checked' : ''} ${off.kanban_status ? 'disabled' : ''} onchange="toggleOffer(${off.id}, this.checked)"> Выбрать</label>${st}<div style="margin-top:2px;">Цена с НДС: <b>${off.price} руб.</b><span style="font-size:11px;color:#334155;">${unitHint}</span></div><div style="color:#475569;">Вес: ${off.kg || '—'} кг | Метры/инфо: <b>${off.meters || '—'}</b></div></td>`;
                }
            } else {
                const cKey = `${inv.id}_${item.id}`;
                if (addingCellKey === cKey) {
                    html += `<td class="col-sup offer-cell" style="background:#fffbeb;border:2px solid #f59e0b;"><div style="font-size:11px;font-weight:bold;margin-bottom:3px;">Новая цена:</div><input type="number" step="0.01" id="new_pr_${cKey}" placeholder="Сумма с НДС" style="padding:3px;margin-bottom:3px;font-size:12px;"><div style="display:flex;gap:4px;margin-bottom:4px;"><input type="text" id="new_kg_${cKey}" placeholder="Вес" style="padding:3px;font-size:11px;"><input type="text" id="new_m_${cKey}" placeholder="Метры" style="padding:3px;font-size:11px;"></div><div style="display:flex;gap:4px;"><button type="button" class="btn-green" style="padding:3px 7px;font-size:11px;flex:1;" onclick="event.stopPropagation();saveNewCell(${inv.id}, ${item.id})">💾 Сохранить</button><button type="button" class="btn-gray" style="padding:3px 7px;font-size:11px;" onclick="addingCellKey=null;keepScrollAndRender()">✖</button></div></td>`;
                } else {
                    html += `<td class="col-sup"><button type="button" onclick="event.stopPropagation();addingCellKey='${cKey}';keepScrollAndRender()" style="background:transparent;color:#94a3b8;border:1px dashed #cbd5e1;padding:2px 6px;font-size:10px;">+ цена</button></td>`;
                }
            }
        });
        html += `</tr>`;
    });

    html += `<tr class="${focusedItemId === 'row_total' ? 'row-focused' : ''}" onclick="focusTableRow('row_total', this)" style="background:#f8fafc;font-weight:bold;"><td class="col-item" style="background:#f8fafc;">Итого по товарам (с НДС):</td>`;
    invoices.forEach(inv => {
        const sum = offers.filter(o => o.invoice_id === inv.id).reduce((a, o) => a + (parseFloat(o.price) || 0), 0);
        html += `<td class="col-sup">${sum.toFixed(2)} руб.</td>`;
    });
    html += `</tr><tr class="${focusedItemId === 'row_deliv' ? 'row-focused' : ''}" onclick="focusTableRow('row_deliv', this)"><td class="col-item"><b>Стоимость доставки до терминала:</b></td>`;
    invoices.forEach(inv => {
        const key = `deliv_${inv.id}`;
        if (editingMetaKey === key) {
            html += `<td class="col-sup" style="background:#fffbeb;border:2px solid #f59e0b;"><input type="number" step="0.01" id="inp_${key}" value="${inv.delivery_cost || ''}" style="padding:3px;margin-bottom:4px;font-size:12px;"><div style="display:flex;gap:4px;"><button type="button" class="btn-green" style="padding:3px 7px;font-size:11px;flex:1;" onclick="event.stopPropagation();saveEditedMeta(${inv.id}, 'delivery_cost', 'inp_${key}')">💾 Сохранить</button><button type="button" class="btn-gray" style="padding:3px 7px;font-size:11px;" onclick="editingMetaKey=null;keepScrollAndRender()">✖</button></div></td>`;
        } else {
            const btn = `<button type="button" onclick="event.stopPropagation();editingMetaKey='${key}';keepScrollAndRender()" style="float:right;background:transparent;color:#475569;border:1px solid #cbd5e1;padding:1px 5px;font-size:11px;">✏️</button>`;
            html += `<td class="col-sup">${btn}${inv.delivery_cost ? '<b>' + inv.delivery_cost + ' руб.</b>' : '<span style="color:#94a3b8;">—</span>'}</td>`;
        }
    });
    html += `</tr><tr class="${focusedItemId === 'row_notes' ? 'row-focused' : ''}" onclick="focusTableRow('row_notes', this)"><td class="col-item"><b>Примечания:</b></td>`;
    invoices.forEach(inv => {
        const key = `notes_${inv.id}`;
        if (editingMetaKey === key) {
            html += `<td class="col-sup" style="background:#fffbeb;border:2px solid #f59e0b;"><textarea id="inp_${key}" rows="2" style="padding:3px;margin-bottom:4px;font-size:11px;">${inv.notes || ''}</textarea><div style="display:flex;gap:4px;"><button type="button" class="btn-green" style="padding:3px 7px;font-size:11px;flex:1;" onclick="event.stopPropagation();saveEditedMeta(${inv.id}, 'notes', 'inp_${key}')">💾 Сохранить</button><button type="button" class="btn-gray" style="padding:3px 7px;font-size:11px;" onclick="editingMetaKey=null;keepScrollAndRender()">✖</button></div></td>`;
        } else {
            const btn = `<button type="button" onclick="event.stopPropagation();editingMetaKey='${key}';keepScrollAndRender()" style="float:right;background:transparent;color:#475569;border:1px solid #cbd5e1;padding:1px 5px;font-size:11px;">✏️</button>`;
            html += `<td class="col-sup">${btn}${inv.notes || '<span style="color:#94a3b8;">—</span>'}</td>`;
        }
    });
    html += `</tr></tbody></table></div>`;
    ws.innerHTML = html;
}


async function saveProjectMeta(projId) {
    const name = document.getElementById('editProjNameInp').value.trim();
    const folder_path = document.getElementById('editProjFolderInp').value.trim();
    if (!name) return;
    await fetch(`/api/projects/${projId}/edit_info`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name, folder_path}) });
    editingProjectMeta = false;
    await selectProject(projId);
    showSaveNotice('✔ Данные проекта сохранены!');
}
async function saveProjectItemName(itemId) {
    const name = document.getElementById(`editItemInp_${itemId}`).value.trim();
    if (!name) return;
    await fetch(`/api/items/${itemId}/edit`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name}) });
    editingItemId = null;
    await selectProject(currentProjectId);
    showSaveNotice('✔ Позиция обновлена!');
}
async function deleteProjectItem(itemId) {
    if (!confirm('Удалить эту строку из заявки?')) return;
    await fetch(`/api/items/${itemId}/delete`, { method: 'POST' });
    await selectProject(currentProjectId);
    showSaveNotice('🗑 Строка удалена');
}
async function addNewItemRow() {
    const name = prompt('Введите название новой позиции:');
    if (!name || !name.trim()) return;
    await fetch(`/api/projects/${currentProjectId}/items`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name: name.trim()}) });
    await selectProject(currentProjectId);
    showSaveNotice('✔ Позиция добавлена!');
}
async function saveInvoiceHeader(invId) {
    const supplier = document.getElementById(`editInvSup_${invId}`).value.trim();
    const invoice_num = document.getElementById(`editInvNum_${invId}`).value.trim();
    if (!supplier) return;
    await fetch(`/api/invoices/${invId}/edit_header`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({supplier, invoice_num}) });
    editingInvoiceId = null;
    await selectProject(currentProjectId);
    showSaveNotice('✔ Данные счёта сохранены!');
}
async function deleteInvoiceCol(invId) {
    if (!confirm('Удалить этот счёт и все его цены из таблицы?')) return;
    await fetch(`/api/invoices/${invId}/delete`, { method: 'POST' });
    await selectProject(currentProjectId);
    showSaveNotice('🗑 Счёт удалён из таблицы');
}
async function saveEditedOffer(offerId) {
    const price = document.getElementById(`edit_pr_${offerId}`).value;
    const kg = document.getElementById(`edit_kg_${offerId}`).value;
    const meters = document.getElementById(`edit_m_${offerId}`).value;
    await fetch(`/api/offers/${offerId}/edit`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({price, kg, meters}) });
    editingOfferId = null;
    await selectProject(currentProjectId);
    showSaveNotice('✔ Изменения в ячейке сохранены!');
}
async function saveNewCell(invId, itemId) {
    const price = document.getElementById(`new_pr_${invId}_${itemId}`).value;
    const kg = document.getElementById(`new_kg_${invId}_${itemId}`).value;
    const meters = document.getElementById(`new_m_${invId}_${itemId}`).value;
    await fetch(`/api/invoices/${invId}/add_cell`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({item_id: itemId, price, kg, meters}) });
    addingCellKey = null;
    await selectProject(currentProjectId);
    showSaveNotice('✔ Цена добавлена в ячейку!');
}
async function saveEditedMeta(invId, field, inputId) {
    const val = document.getElementById(inputId).value;
    await fetch(`/api/invoices/${invId}/edit_meta`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({field, value: val}) });
    editingMetaKey = null;
    await selectProject(currentProjectId);
    showSaveNotice('✔ Сохранено!');
}

async function promptAttachFile(invId) {
    const fList = (currentProjectData && currentProjectData.folder_files) || [];
    if (fList.length > 0) {
        const menu = fList.map((fn, idx) => `${idx + 1}. ${fn}`).join('\n');
        const ans = prompt(`Выберите номер файла из папки проекта (или 0 для загрузки с диска):\n\n${menu}`, '1');
        if (ans === null) return;
        const num = parseInt(ans.trim(), 10);
        if (num >= 1 && num <= fList.length) {
            await fetch(`/api/invoices/${invId}/attach_file`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({filename: fList[num - 1]}) });
            await selectProject(currentProjectId);
            showSaveNotice('✔ Файл счёта привязан!');
            return;
        }
    }
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.pdf,.xlsx,.xlsm,.xls,.ods,.jpg,.jpeg,.png';
    inp.onchange = async () => {
        if (!inp.files.length) return;
        const fd = new FormData();
        fd.append('file', inp.files.item(0));
        await fetch(`/api/invoices/${invId}/attach_file`, { method: 'POST', body: fd });
        await selectProject(currentProjectId);
        showSaveNotice('✔ Файл счёта загружен и привязан!');
    };
    inp.click();
}
async function detachInvoiceFile(invId) {
    await fetch(`/api/invoices/${invId}/detach_file`, { method: 'POST' });
    await selectProject(currentProjectId);
    showSaveNotice('✖ Привязка счёта отменена');
}
function openInvoiceModal() {
    document.getElementById('invSupplier').value = '';
    document.getElementById('invNum').value = '';
    document.getElementById('invFile').value = '';
    document.getElementById('invExtractedText').value = '';
    document.getElementById('invDelivery').value = '';
    document.getElementById('invNotes').value = '';
    document.getElementById('scanWarning').style.display = 'none';
    document.getElementById('vatResult').innerText = '';
    const container = document.getElementById('invItemsContainer');
    container.innerHTML = '<h4>Заполните предложенные позиции:</h4>';
    currentProjectData.items.forEach(item => {
        container.innerHTML += `<div style="border:1px solid #e2e8f0;padding:8px;border-radius:5px;margin-bottom:6px;background:#f8fafc;"><div style="font-weight:bold;margin-bottom:5px;">${item.name}</div><div style="display:flex;gap:8px;"><input type="number" step="0.01" id="off_price_${item.id}" placeholder="Сумма с НДС (руб.)"><input type="text" id="off_kg_${item.id}" placeholder="Вес (кг)"><input type="text" id="off_m_${item.id}" placeholder="Метры (м)"></div></div>`;
    });
    document.getElementById('invoiceModal').style.display = 'flex';
}
async function parseInvoiceFile() {
    const fileInput = document.getElementById('invFile');
    if (!fileInput.files.length) return;
    const formData = new FormData();
    formData.append('file', fileInput.files.item(0));
    const res = await fetch('/api/parse_preview', { method: 'POST', body: formData });
    const data = await res.json();
    if (data.is_scan) {
        document.getElementById('scanWarning').style.display = 'block';
        document.getElementById('invExtractedText').value = '';
    } else {
        document.getElementById('scanWarning').style.display = 'none';
        document.getElementById('invExtractedText').value = data.text;
        if (data.supplier && !document.getElementById('invSupplier').value) document.getElementById('invSupplier').value = data.supplier;
        if (data.invoice_num && !document.getElementById('invNum').value) document.getElementById('invNum').value = data.invoice_num;
        const rawLines = data.text.split('\n').map(l => l.trim()).filter(Boolean);
        const mergedLines = [];
        for (let i = 0; i < rawLines.length; i++) {
            mergedLines.push(rawLines[i]);
            if (i + 1 < rawLines.length) mergedLines.push(rawLines[i] + ' ' + rawLines[i + 1]);
        }

        // Сначала находим лучшее совпадение для каждой позиции заявки, чтобы одна строка счёта не попала в 2 товара
        const usedLineIndexes = new Set();
        const itemMatches = currentProjectData.items.map(item => {
            const low = item.name.toLowerCase().replace(/х/g, 'x');
            const tokens = low.replace(/[^а-яa-z0-9.,-]/g, ' ').split(/\s+/)
                .filter(w => w.length >= 2 && !['шт','штук','штуки','мм','м','кг','под','этот','размер','длиной','для'].includes(w));
            let bestIdx = -1, bestScore = 0, bestRatio = 0;
            mergedLines.forEach((line, idx) => {
                const lLow = line.toLowerCase().replace(/х/g, 'x');
                if (lLow.includes('итого') || lLow.includes('всего к оплате') || lLow.includes('в том числе ндс')) return;
                if (!/[0-9]+[.,][0-9]{2}/.test(line)) return;
                let score = 0;
                tokens.forEach(t => { if (lLow.includes(t)) score++; });
                const ratio = tokens.length > 0 ? score / tokens.length : 0;
                if (score > bestScore || (score === bestScore && ratio > bestRatio)) {
                    bestScore = score;
                    bestRatio = ratio;
                    bestIdx = idx;
                }
            });
            return { item, bestIdx, bestScore, bestRatio, tokensCount: tokens.length };
        });

        // Сортируем от наиболее точных совпадений к менее точным
        itemMatches.sort((a, b) => (b.bestScore - a.bestScore) || (b.bestRatio - a.bestRatio));

        itemMatches.forEach(m => {
            const item = m.item;
            const low = item.name.toLowerCase();
            const prInp = document.getElementById(`off_price_${item.id}`);
            if (data.cut_price && (low.includes('порезка') || low.includes('раскрой'))) { prInp.value = data.cut_price; return; }
            if (data.deliv_price && low.includes('доставка')) { prInp.value = data.deliv_price; return; }

            // Требуем совпадения минимум 2 признаков (или 1, если в названии товара всего 1-2 слова) и чтобы строка ещё не была занята
            const minRequired = m.tokensCount >= 3 ? 2 : 1;
            if (m.bestIdx !== -1 && m.bestScore >= minRequired && !usedLineIndexes.has(m.bestIdx)) {
                usedLineIndexes.add(m.bestIdx);
                // Помечаем соседнюю склеенную строку тоже как занятую
                usedLineIndexes.add(m.bestIdx - 1);
                usedLineIndexes.add(m.bestIdx + 1);
                const bestLine = mergedLines[m.bestIdx];
                const money = bestLine.match(/[0-9]{1,3}(?:[\s\u00a0]?[0-9]{3})*[.,][0-9]{2}/g);
                if (money && money.length > 0) {
                    let val = parseFloat(money[money.length - 1].replace(/[\s\u00a0]/g, '').replace(',', '.'));
                    const mSub = data.text.match(/Итого\s*:[^0-9\n]*([0-9]{1,3}(?:[\s\u00a0]?[0-9]{3})*[.,][0-9]{2})/i);
                    const mVat = data.text.match(/Итого\s+НДС\s*:[^0-9\n]*([0-9]{1,3}(?:[\s\u00a0]?[0-9]{3})*[.,][0-9]{2})/i);
                    if (mSub && mVat && data.total_sum) {
                        const subVal = parseFloat(mSub[1].replace(/[\s\u00a0]/g, '').replace(',', '.'));
                        const totVal = parseFloat(data.total_sum);
                        if (subVal > 0 && totVal > subVal && Math.abs(val - subVal) < 1) val = totVal;
                        else if (subVal > 0 && totVal > subVal) val = +(val * (totVal / subVal)).toFixed(2);
                    }
                    prInp.value = val.toFixed(2);
                }
            } else if (currentProjectData.items.length === 1 && data.total_sum && !prInp.value) {
                prInp.value = data.total_sum;
            }
        });
    }
}

function calcVat(mult) {
    const val = parseFloat(document.getElementById('vatInput').value);
    if (!isNaN(val)) document.getElementById('vatResult').innerText = '= ' + (val * mult).toFixed(2) + ' руб. с НДС';
}
async function saveInvoice() {
    const supplier = document.getElementById('invSupplier').value.trim();
    if (!supplier) { alert('Укажите название поставщика!'); return; }
    const formData = new FormData();
    formData.append('project_id', currentProjectId);
    formData.append('supplier', supplier);
    formData.append('invoice_num', document.getElementById('invNum').value.trim());
    formData.append('delivery_cost', document.getElementById('invDelivery').value || 0);
    formData.append('notes', document.getElementById('invNotes').value.trim());
    const fileInput = document.getElementById('invFile');
    if (fileInput.files.length) formData.append('file', fileInput.files.item(0));
    const offersData = [];
    currentProjectData.items.forEach(item => {
        offersData.push({
            item_id: item.id,
            price: document.getElementById(`off_price_${item.id}`).value || 0,
            kg: document.getElementById(`off_kg_${item.id}`).value.trim(),
            meters: document.getElementById(`off_m_${item.id}`).value.trim()
        });
    });
    formData.append('offers', JSON.stringify(offersData));
    await fetch('/api/invoices', { method: 'POST', body: formData });
    closeModal('invoiceModal');
    selectProject(currentProjectId);
}
async function toggleOffer(offerId, isSelected) {
    await fetch(`/api/offers/${offerId}/select`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({selected: isSelected ? 1 : 0}) });
    selectProject(currentProjectId);
}
async function toggleInvoiceAll(invId, selectFlag) {
    await fetch(`/api/invoices/${invId}/select_all`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({selected: selectFlag ? 1 : 0}) });
    selectProject(currentProjectId);
}
async function importComparisonTable() {
    const inp = document.getElementById('importExcelInput');
    if (!inp.files.length) return;
    const formData = new FormData();
    formData.append('file', inp.files.item(0));
    const res = await fetch(`/api/projects/${currentProjectId}/import_table`, { method: 'POST', body: formData });
    const data = await res.json();
    inp.value = '';
    if (data.ok) { alert(`Импорт завершён! Позиций: ${data.items_added}, счетов: ${data.invoices_added}`); selectProject(currentProjectId); }
    else alert('Ошибка импорта: ' + (data.error || 'неизвестный формат'));
}
async function sendSelectedToWork() {
    const hasSelected = currentProjectData && currentProjectData.offers.some(o => o.selected === 1 && !o.kanban_status);
    if (!hasSelected) {
        alert('Сначала отметьте галочкой "Выбрать" нужные цены или нажмите "☐ Выбрать весь счёт" в шапке поставщика!');
        return;
    }
    await fetch(`/api/projects/${currentProjectId}/to_work`, { method: 'POST' });
    showSaveNotice('✔ Выбранные позиции переданы в работу!');
    await selectProject(currentProjectId);
    const tab2Btn = document.querySelectorAll('.tab-btn')[2];
    if (tab2Btn) switchTab('kanban', tab2Btn);
}

let activeKanbanProjectId = null;
let kanbanCardsCache = [];
async function loadKanban() {
    const res = await fetch('/api/kanban');
    kanbanCardsCache = await res.json();
    renderKanbanProjectsSidebar();
    renderKanbanBoard();
}
function renderKanbanProjectsSidebar() {
    const sb = document.getElementById('kanbanProjectsList');
    if (!sb) return;
    sb.innerHTML = '';
    const projMap = new Map();
    kanbanCardsCache.forEach(c => {
        if (!projMap.has(c.project_id)) projMap.set(c.project_id, { id: c.project_id, name: c.project_name, count: 0 });
        projMap.get(c.project_id).count += 1;
    });
    const allDiv = document.createElement('div');
    allDiv.className = 'proj-item' + (activeKanbanProjectId === null ? ' active' : '');
    allDiv.innerHTML = `<div style="font-size:13px;">Все проекты в работе (${kanbanCardsCache.length} сч.)</div>`;
    allDiv.onclick = () => { activeKanbanProjectId = null; renderKanbanProjectsSidebar(); renderKanbanBoard(); };
    sb.appendChild(allDiv);
    projMap.forEach(p => {
        const div = document.createElement('div');
        div.className = 'proj-item' + (activeKanbanProjectId === p.id ? ' active' : '');
        div.innerHTML = `<div style="font-size:13px;">📁 ${p.name}</div><div style="font-size:11px;color:#64748b;">Счетов в работе: <b>${p.count}</b></div>`;
        div.onclick = () => { activeKanbanProjectId = p.id; renderKanbanProjectsSidebar(); renderKanbanBoard(); };
        sb.appendChild(div);
    });
}
function renderKanbanBoard() {
    ['accounting', 'paid', 'transit', 'arrived'].forEach(st => document.getElementById('k-' + st).innerHTML = '');
    const today = new Date().toISOString().split('T');
    const filtered = activeKanbanProjectId === null ? kanbanCardsCache : kanbanCardsCache.filter(c => c.project_id === activeKanbanProjectId);
    filtered.forEach(c => {
        const div = document.createElement('div');
        div.className = 'k-card' + (c.arrival_date && c.arrival_date <= today ? ' overdue' : '');
        div.draggable = true;
        div.ondragstart = (e) => { e.dataTransfer.setData('text/plain', JSON.stringify({inv_id: c.invoice_id, old_status: c.kanban_status})); };
        let fileLink = c.filename ? `<a href="/api/invoice_file/${c.invoice_id}" target="_blank" style="font-size:11px;color:#2563eb;text-decoration:none;white-space:nowrap;">📄 Счёт</a>` : '';
        const invLabel = (c.invoice_num && c.invoice_num !== 'Из таблицы') ? ` — ${c.invoice_num}` : '';
        const steps = ['accounting', 'paid', 'transit', 'arrived'];
        const stepLabels = { accounting: 'В бухгалтерию', paid: 'Оплачено', transit: 'В пути', arrived: 'Прибыло' };
        const idx = steps.indexOf(c.kanban_status);
        const prevBtn = idx > 0 ? `<button type="button" class="btn-gray" style="padding:2px 6px;font-size:10px;" onclick="moveCardStep(${c.invoice_id}, '${c.kanban_status}', '${steps[idx - 1]}')" title="Вернуть на предыдущий этап">◀</button>` : '';
        const nextBtn = idx < steps.length - 1 ? `<button type="button" style="background:#0284c7;padding:2px 6px;font-size:10px;flex:1;" onclick="moveCardStep(${c.invoice_id}, '${c.kanban_status}', '${steps[idx + 1]}')">➡ ${stepLabels[steps[idx + 1]]}</button>` : '';
        div.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:baseline;gap:4px;"><span style="font-size:11px;font-weight:bold;color:#1d4ed8;">📁 ${c.project_name}</span><span style="font-size:11px;color:#475569;white-space:nowrap;">${c.items_count} поз. | <b>${(c.total_price || 0).toFixed(2)} р.</b></span></div><div style="font-size:11px;font-weight:bold;color:#0f172a;margin:2px 0 4px 0;">${c.supplier}${invLabel}</div><div style="margin-bottom:3px;"><input type="text" placeholder="ТК" value="${c.carrier || ''}" onchange="updateLogistics(${c.invoice_id}, 'carrier', this.value)" style="padding:2px 5px;font-size:11px;height:22px;"></div><div style="display:flex;gap:4px;margin-bottom:4px;"><input type="text" placeholder="Трек-номер" value="${c.track_num || ''}" onchange="updateLogistics(${c.invoice_id}, 'track_num', this.value)" style="padding:2px 5px;font-size:11px;height:22px;flex:1;min-width:0;"><input type="date" value="${c.arrival_date || ''}" onchange="updateLogistics(${c.invoice_id}, 'arrival_date', this.value)" style="padding:1px 4px;font-size:11px;height:22px;width:112px;flex-shrink:0;"></div><div style="display:flex;align-items:center;gap:4px;">${prevBtn}${nextBtn}${fileLink}<button class="btn-green" style="padding:2px 7px;font-size:10px;white-space:nowrap;" onclick="openColorModal(${c.invoice_id})">✔ Получено</button></div>`;
        if (document.getElementById('k-' + c.kanban_status)) document.getElementById('k-' + c.kanban_status).appendChild(div);
    });
}
async function moveCardStep(invId, oldStatus, newStatus) {
    await fetch(`/api/kanban/invoice/${invId}/status`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({status: newStatus, old_status: oldStatus}) });
    loadKanban();
    loadProjects();
}
function allowDrop(e) { e.preventDefault(); }
async function dropCard(e, newStatus) {
    e.preventDefault();
    const payload = JSON.parse(e.dataTransfer.getData('text/plain'));
    await fetch(`/api/kanban/invoice/${payload.inv_id}/status`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({status: newStatus, old_status: payload.old_status}) });
    loadKanban();
    loadProjects();
}
async function updateLogistics(invId, field, value) {
    await fetch(`/api/kanban/invoice/${invId}/logistics`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({field, value}) });
}
function openColorModal(invId) { document.getElementById('receiveOfferId').value = invId; document.getElementById('colorModal').style.display = 'flex'; }
async function confirmReceive(colorClass) {
    const invId = document.getElementById('receiveOfferId').value;
    await fetch(`/api/kanban/invoice/${invId}/receive`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({color: colorClass}) });
    closeModal('colorModal');
    loadKanban();
    loadProjects();
    if (currentProjectId) selectProject(currentProjectId);
}

let receivedDataCache = { invoices: [], items: [] };
let activeReceivedInvId = null;
async function loadReceived() {
    const res = await fetch('/api/received');
    receivedDataCache = await res.json();
    renderReceivedSidebar();
    if (activeReceivedInvId && receivedDataCache.invoices.some(x => x.invoice_id === activeReceivedInvId)) selectReceivedInvoice(activeReceivedInvId);
    else if (receivedDataCache.invoices.length > 0) selectReceivedInvoice(receivedDataCache.invoices[0].invoice_id);
    else document.getElementById('receivedDetailsWorkspace').innerHTML = '<p style="color: #64748b;">Пока нет полученных счетов.</p>';
}
function renderReceivedSidebar() {
    const listEl = document.getElementById('receivedInvoicesList');
    if (!listEl) return;
    listEl.innerHTML = '';
    receivedDataCache.invoices.forEach(inv => {
        const div = document.createElement('div');
        const isAct = inv.invoice_id === activeReceivedInvId;
        div.className = `proj-item ${inv.received_color}` + (isAct ? ' active' : '');
        div.style.marginBottom = '8px';
        div.style.border = isAct ? '2px solid #2563eb' : '1px solid #cbd5e1';
        const invNum = (inv.invoice_num && inv.invoice_num !== 'Из таблицы') ? ` — ${inv.invoice_num}` : '';
        div.innerHTML = `<div style="font-size:12px;font-weight:bold;color:#1e3a8a;">📁 ${inv.project_name}</div><div style="font-size:13px;font-weight:bold;color:#0f172a;margin-top:2px;">${inv.supplier}${invNum}</div><div style="font-size:11px;color:#334155;margin-top:3px;">Позиций: <b>${inv.items_count}</b> | Сумма: <b>${(inv.total_price || 0).toFixed(2)} руб.</b></div>`;
        div.onclick = () => selectReceivedInvoice(inv.invoice_id);
        listEl.appendChild(div);
    });
}
function selectReceivedInvoice(invId) {
    activeReceivedInvId = invId;
    renderReceivedSidebar();
    const inv = receivedDataCache.invoices.find(x => x.invoice_id === invId);
    if (!inv) return;
    const items = receivedDataCache.items.filter(it => it.invoice_id === invId);
    const invNum = (inv.invoice_num && inv.invoice_num !== 'Из таблицы') ? ` — ${inv.invoice_num}` : '';
    const fileLink = inv.filename ? `<a href="/api/invoice_file/${inv.invoice_id}" target="_blank" style="font-size:12px;color:#2563eb;margin-left:10px;">📄 Открыть файл счёта</a>` : '';
    let html = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #e2e8f0;"><div><div style="font-size:12px;color:#64748b;">Проект: <b>${inv.project_name}</b></div><h3 style="margin:2px 0 0 0;font-size:16px;">${inv.supplier}${invNum} ${fileLink}</h3></div><div style="font-size:12px;">Цвет счёта: <span class="c-box c-1" onclick="changeInvoiceColor(${inv.invoice_id}, 'c-1')"></span><span class="c-box c-2" onclick="changeInvoiceColor(${inv.invoice_id}, 'c-2')"></span><span class="c-box c-3" onclick="changeInvoiceColor(${inv.invoice_id}, 'c-3')"></span><span class="c-box c-4" onclick="changeInvoiceColor(${inv.invoice_id}, 'c-4')"></span><span class="c-box c-5" onclick="changeInvoiceColor(${inv.invoice_id}, 'c-5')"></span><span class="c-box c-6" onclick="changeInvoiceColor(${inv.invoice_id}, 'c-6')"></span><span class="c-box c-7" onclick="changeInvoiceColor(${inv.invoice_id}, 'c-7')"></span></div></div><table style="width:100%;"><thead><tr><th>Позиция</th><th style="width:180px;">Вес (кг) / Метры</th><th style="width:140px;">Стоимость (с НДС)</th><th style="width:230px;">Цвет позиции</th></tr></thead><tbody>`;
    items.forEach(r => {
        html += `<tr class="${r.received_color}"><td><b>${r.item_name}</b></td><td>${r.kg || '—'} кг / <b>${r.meters || '—'} м</b></td><td><b>${r.price} руб.</b></td><td><span class="c-box c-1" onclick="changeColor(${r.offer_id}, 'c-1')"></span><span class="c-box c-2" onclick="changeColor(${r.offer_id}, 'c-2')"></span><span class="c-box c-3" onclick="changeColor(${r.offer_id}, 'c-3')"></span><span class="c-box c-4" onclick="changeColor(${r.offer_id}, 'c-4')"></span><span class="c-box c-5" onclick="changeColor(${r.offer_id}, 'c-5')"></span><span class="c-box c-6" onclick="changeColor(${r.offer_id}, 'c-6')"></span><span class="c-box c-7" onclick="changeColor(${r.offer_id}, 'c-7')"></span></td></tr>`;
    });
    html += `</tbody></table>`;
    document.getElementById('receivedDetailsWorkspace').innerHTML = html;
}
async function changeInvoiceColor(invId, colorClass) {
    await fetch(`/api/received/invoice/${invId}/color`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({color: colorClass}) });
    loadReceived();
    if (currentProjectId) selectProject(currentProjectId);
}
async function changeColor(offerId, colorClass) {
    await fetch(`/api/offers/${offerId}/receive`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({color: colorClass}) });
    loadReceived();
    if (currentProjectId) selectProject(currentProjectId);
}

let currentArchiveId = null;
async function archiveProject(projId, archFlag) {
    await fetch(`/api/projects/${projId}/archive`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({archived: archFlag}) });
    if (archFlag === 1) {
        currentProjectId = null;
        document.getElementById('projectWorkspace').innerHTML = '<p style="color: #64748b;">Проект перенесён в архив.</p>';
        loadProjects();
        showSaveNotice('📦 Проект перенесён в архив!');
    } else {
        currentArchiveId = null;
        document.getElementById('archiveWorkspace').innerHTML = '<p style="color: #64748b;">Проект возвращён в активные.</p>';
        loadArchiveProjects();
        loadProjects();
        showSaveNotice('↩ Проект возвращён из архива!');
    }
}
async function loadArchiveProjects() {
    const res = await fetch('/api/projects?archived=1');
    const list = await res.json();
    const container = document.getElementById('archiveProjectList');
    if (!container) return;
    container.innerHTML = list.length ? '' : '<div style="font-size:12px;color:#64748b;">Архив пока пуст.</div>';
    list.forEach(p => {
        const div = document.createElement('div');
        div.className = 'proj-item' + (p.id === currentArchiveId ? ' active' : '');
        div.style.background = '#f1f5f9';
        div.innerHTML = `<div style="font-size:13px;">📦 ${p.name}</div><div style="font-size:11px;color:#64748b;">📅 ${p.created_at || ''}</div>`;
        div.onclick = () => selectArchiveProject(p.id);
        container.appendChild(div);
    });
}
async function selectArchiveProject(id) {
    currentArchiveId = id;
    loadArchiveProjects();
    const res = await fetch(`/api/projects/${id}`);
    const data = await res.json();
    const ws = document.getElementById('archiveWorkspace');
    const p = data.project;
    const paidStatuses = ['paid', 'transit', 'arrived', 'received'];
    const paidInvoices = data.invoices.filter(inv => data.offers.some(o => o.invoice_id === inv.id && (paidStatuses.includes(o.kanban_status) || o.received_color)));
    let html = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;"><div><h3 style="margin:0;font-size:16px;">📦 [Архив] ${p.name}</h3><small style="color:#64748b;font-size:11px;">Оплаченные счета: ${paidInvoices.length}</small></div><button style="background:#2563eb;" onclick="archiveProject(${p.id}, 0)">↩ Вернуть из архива</button></div>`;
    if (!paidInvoices.length) { ws.innerHTML = html + '<p style="color:#64748b;">В этом архивном проекте нет оплаченных счетов.</p>'; return; }
    html += `<div class="table-scroll"><table><thead><tr><th class="col-item">Заказываемый материал</th>`;
    paidInvoices.forEach(inv => {
        let fl = inv.filename ? `<div style="margin-top:3px;"><a href="/api/invoice_file/${inv.id}" target="_blank" style="font-size:11px;color:#2563eb;">📄 Счёт</a></div>` : '';
        html += `<th class="col-sup"><div>${inv.supplier}</div><div style="font-weight:normal;font-size:11px;">${inv.invoice_num || ''}</div>${fl}</th>`;
    });
    html += `</tr></thead><tbody>`;
    data.items.forEach(item => {
        const rec = data.offers.find(o => o.item_id === item.id && o.received_color);
        html += `<tr><td class="col-item ${rec ? rec.received_color : ''}"><b>${item.name}</b></td>`;
        paidInvoices.forEach(inv => {
            const off = data.offers.find(o => o.invoice_id === inv.id && o.item_id === item.id);
            if (off && (off.price > 0 || off.kg || off.meters)) html += `<td class="col-sup"><div>Цена: <b>${off.price} руб.</b></div><div style="color:#475569;">Вес: ${off.kg || '—'} кг | Метры: <b>${off.meters || '—'}</b></div></td>`;
            else html += `<td class="col-sup"></td>`;
        });
        html += `</tr>`;
    });
    html += `</tbody></table></div>`;
    ws.innerHTML = html;
}
async function makeBackupNow() {
    const res = await fetch('/api/backup_now', { method: 'POST' });
    const data = await res.json();
    if (data.ok) showSaveNotice('💾 Резервная копия базы создана: ' + data.file);
}
async function makeCodeBackupNow() {
    const res = await fetch('/api/backup_code', { method: 'POST' });
    const data = await res.json();
    if (data.ok) showSaveNotice('📦 Архив программы сохранён: ' + data.file);
}
loadProjects();

function focusTableRow(itemId, trEl) {
    focusedItemId = itemId;
    document.querySelectorAll('tr.row-focused').forEach(r => r.classList.remove('row-focused'));
    if (trEl) trEl.classList.add('row-focused');
}
