window.onerror = function(msg, url, line, col) {
    fetch('/api/client_log', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({msg: String(msg), line: line, col: col})
    }).catch(() => {});
};

let currentProjectId = null;
let currentProjectData = null;

function switchTab(tabName, btn) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('view-' + tabName).classList.add('active');
    btn.classList.add('active');
    if (tabName === 'kanban') loadKanban();
    if (tabName === 'received') loadReceived();
}

function openProjectModal() { document.getElementById('projectModal').style.display = 'flex'; }
function closeModal(id) { document.getElementById(id).style.display = 'none'; }

async function browseFolder() {
    const res = await fetch('/api/select_folder');
    const data = await res.json();
    if (data.folder) document.getElementById('newProjFolder').value = data.folder;
}

async function loadProjects() {
    const res = await fetch('/api/projects');
    const list = await res.json();
    const container = document.getElementById('projectList');
    container.innerHTML = '';
    list.forEach(p => {
        const div = document.createElement('div');
        div.className = 'proj-item' + (p.id === currentProjectId ? ' active' : '');
        let b = '';
        if (p.stats) {
            if (p.stats.accounting) b += `<span class="badge-st" style="background:#fef08a;color:#854d0e;">На оплату: ${p.stats.accounting}</span>`;
            if (p.stats.paid) b += `<span class="badge-st" style="background:#bae6fd;color:#075985;">Оплачено: ${p.stats.paid}</span>`;
            if (p.stats.transit) b += `<span class="badge-st" style="background:#fed7aa;color:#9a3412;">В пути: ${p.stats.transit}</span>`;
            if (p.stats.received) b += `<span class="badge-st" style="background:#bbf7d0;color:#166534;">Получено: ${p.stats.received}</span>`;
        }
        div.innerHTML = `<div style="font-size:13px;">${p.name}</div><div style="font-size:11px;color:#64748b;">📅 ${p.created_at || ''}</div><div>${b}</div>`;
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
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
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
    if (newSc) {
        newSc.scrollLeft = prevLeft;
        newSc.scrollTop = prevTop;
    }
}

async function toggleInvoiceAll(invId, selectFlag) {
    await fetch(`/api/invoices/${invId}/select_all`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({selected: selectFlag ? 1 : 0})
    });
    selectProject(currentProjectId);
}

function extractNum(val) {
    if (!val) return 0;
    const m = String(val).replace(',', '.').match(/[0-9]+(?:\.[0-9]+)?/);
    return m ? parseFloat(m[0]) : 0;
}

function renderComparisonTable() {
    const ws = document.getElementById('projectWorkspace');
    const p = currentProjectData.project;
    const items = currentProjectData.items;
    const invoices = currentProjectData.invoices;
    const offers = currentProjectData.offers;
    const fList = currentProjectData.folder_files || [];

    let filesHtml = fList.length ? `<div style="margin-top:8px;padding:6px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:5px;"><div style="font-size:11px;font-weight:bold;color:#475569;margin-bottom:4px;">📂 Файлы в проекте (${fList.length}):</div><div style="display:flex;flex-wrap:wrap;gap:5px;">` + fList.map(fn => `<a href="/api/projects/${p.id}/folder_file/${encodeURIComponent(fn)}" target="_blank" style="background:#fff;padding:2px 6px;border:1px solid #cbd5e1;border-radius:3px;text-decoration:none;color:#1e293b;font-size:11px;">📄 ${fn}</a>`).join('') + `</div></div>` : '';

    let html = `<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;"><div><h3 style="margin:0;font-size:16px;">${p.name}</h3><small style="color:#64748b;font-size:11px;">Папка: ${p.folder_path}</small></div><div style="display:flex;gap:8px;flex-shrink:0;"><input type="file" id="importExcelInput" accept=".xlsx,.xlsm,.xls,.ods" style="display:none" onchange="importComparisonTable()"><button style="background:#0284c7;" onclick="document.getElementById('importExcelInput').click()">📥 Импорт таблицы</button><button onclick="openInvoiceModal()">+ Добавить счёт</button><button class="btn-green" onclick="sendSelectedToWork()">✔ В работу</button></div></div>${filesHtml}<div style="font-size:11px;margin-top:6px;color:#475569;">Подсветка: <span style="background:#dcfce7;padding:1px 6px;border:1px solid #86efac;">Лучшая цена</span> <span style="background:#dbeafe;padding:1px 6px;border:1px solid #93c5fd;">Выгоднее за м / кг</span> <span style="background:#ffe4e6;padding:1px 6px;border:1px solid #fda4af;">Самая дорогая</span></div><div class="table-scroll"><table><thead><tr><th class="col-item">Заказываемый материал (Заявка)</th>`;

    invoices.forEach(inv => {
        const invOffers = offers.filter(o => o.invoice_id === inv.id && !o.kanban_status && (o.price > 0 || o.kg || o.meters));
        const allSelected = invOffers.length > 0 && invOffers.every(o => o.selected === 1);
        const btnText = allSelected ? '☑ Снять весь счёт' : '☐ Выбрать весь счёт';
        const btnStyle = allSelected ? 'background:#16a34a;color:#fff;' : 'background:#e2e8f0;color:#1e293b;';
        const selectAllBtn = invOffers.length > 0 ? `<div style="margin-top:5px;"><button type="button" style="${btnStyle}padding:3px 7px;font-size:11px;width:100%;" onclick="toggleInvoiceAll(${inv.id}, ${!allSelected})">${btnText}</button></div>` : '';
        let fl = inv.filename ? `<div style="margin-top:3px;"><a href="/api/invoice_file/${inv.id}" target="_blank" style="font-size:11px;color:#2563eb;">📄 Открыть счёт</a></div>` : '';
        html += `<th class="col-sup"><div>${inv.supplier}</div><div style="font-weight:normal;font-size:11px;color:#475569;">${inv.invoice_num || ''}</div>${fl}${selectAllBtn}</th>`;
    });
    html += `</tr></thead><tbody>`;

    items.forEach(item => {
        const rec = offers.find(o => o.item_id === item.id && o.received_color);
        const lowName = item.name.toLowerCase();
        const isService = lowName.includes('порезка') || lowName.includes('раскрой') || lowName.includes('доставка');

        // Собираем все предложения по текущей строке для анализа цен
        const rowOffers = offers.filter(o => o.item_id === item.id && parseFloat(o.price) > 0);
        let minTotal = Infinity, maxTotal = -Infinity;
        let minUnitM = Infinity, minUnitKg = Infinity;

        if (!isService && rowOffers.length > 1) {
            rowOffers.forEach(o => {
                const pr = parseFloat(o.price);
                if (pr < minTotal) minTotal = pr;
                if (pr > maxTotal) maxTotal = pr;
                const mVal = extractNum(o.meters);
                const kgVal = extractNum(o.kg);
                if (mVal > 0 && (pr / mVal) < minUnitM) minUnitM = pr / mVal;
                if (kgVal > 0 && (pr / kgVal) < minUnitKg) minUnitKg = pr / kgVal;
            });
        }

        html += `<tr class="${rec ? rec.received_color : ''}"><td class="col-item" style="${rec ? 'background:inherit;' : ''}"><b>${item.name}</b></td>`;
        invoices.forEach(inv => {
            const off = offers.find(o => o.invoice_id === inv.id && o.item_id === item.id);
            if (off && (off.price > 0 || off.kg || off.meters)) {
                const pr = parseFloat(off.price) || 0;
                const mVal = extractNum(off.meters);
                const kgVal = extractNum(off.kg);
                let cellBg = '';
                let unitHint = '';

                if (mVal > 0 && pr > 0) unitHint += ` (${(pr / mVal).toFixed(0)} р/м)`;
                else if (kgVal > 0 && pr > 0) unitHint += ` (${(pr / kgVal).toFixed(0)} р/кг)`;

                if (!isService && rowOffers.length > 1 && pr > 0) {
                    const isBestTotal = Math.abs(pr - minTotal) < 0.01;
                    const isWorstTotal = Math.abs(pr - maxTotal) < 0.01 && maxTotal > minTotal;
                    const isBestUnitM = mVal > 0 && Math.abs((pr / mVal) - minUnitM) < 0.01;
                    const isBestUnitKg = kgVal > 0 && Math.abs((pr / kgVal) - minUnitKg) < 0.01;

                    if (isBestTotal) {
                        cellBg = 'price-best';
                    } else if (isBestUnitM || isBestUnitKg) {
                        cellBg = 'price-unit-best';
                    } else if (isWorstTotal) {
                        cellBg = 'price-worst';
                    }
                }

                const st = off.kanban_status ? `<span style="color:#15803d;font-weight:bold;font-size:11px;"> [В работе]</span>` : '';
                html += `<td class="col-sup offer-cell ${cellBg} ${off.selected ? 'offer-selected' : ''}"><label style="cursor:pointer;font-weight:bold;font-size:11px;"><input type="checkbox" ${off.selected ? 'checked' : ''} ${off.kanban_status ? 'disabled' : ''} onchange="toggleOffer(${off.id}, this.checked)"> Выбрать</label>${st}<div style="margin-top:2px;">Цена с НДС: <b>${off.price} руб.</b><span style="font-size:11px;color:#334155;">${unitHint}</span></div><div style="color:#475569;">Вес: ${off.kg || '—'} кг | Метры/инфо: <b>${off.meters || '—'}</b></div></td>`;
            } else { html += `<td class="col-sup"></td>`; }
        });
        html += `</tr>`;
    });

    html += `<tr style="background:#f8fafc;font-weight:bold;"><td class="col-item" style="background:#f8fafc;">Итого по товарам (с НДС):</td>`;
    invoices.forEach(inv => {
        const sum = offers.filter(o => o.invoice_id === inv.id).reduce((a, o) => a + (parseFloat(o.price) || 0), 0);
        html += `<td class="col-sup">${sum.toFixed(2)} руб.</td>`;
    });
    html += `</tr><tr><td class="col-item"><b>Стоимость доставки до терминала:</b></td>`;
    invoices.forEach(inv => { html += `<td class="col-sup">${inv.delivery_cost ? inv.delivery_cost + ' руб.' : ''}</td>`; });
    html += `</tr><tr><td class="col-item"><b>Примечания (ГОСТ, страна, сроки):</b></td>`;
    invoices.forEach(inv => { html += `<td class="col-sup">${inv.notes || ''}</td>`; });
    html += `</tr></tbody></table></div>`;
    ws.innerHTML = html;
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
    container.innerHTML = '<h4>Заполните предложенные позиции (оставьте пустым, если позиции нет в счёте):</h4>';
    currentProjectData.items.forEach(item => {
        container.innerHTML += `<div style="border:1px solid #e2e8f0;padding:8px;border-radius:5px;margin-bottom:6px;background:#f8fafc;"><div style="font-weight:bold;margin-bottom:5px;">${item.name}</div><div style="display:flex;gap:8px;"><input type="number" step="0.01" id="off_price_${item.id}" placeholder="Сумма с НДС (руб.)"><input type="text" id="off_kg_${item.id}" placeholder="Вес из счёта (кг)"><input type="text" id="off_m_${item.id}" placeholder="Добавить метры (м)"></div></div>`;
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
        currentProjectData.items.forEach(item => {
            const low = item.name.toLowerCase();
            if (data.cut_price && (low.includes('порезка') || low.includes('раскрой'))) document.getElementById(`off_price_${item.id}`).value = data.cut_price;
            if (data.deliv_price && low.includes('доставка')) document.getElementById(`off_price_${item.id}`).value = data.deliv_price;
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
    await fetch(`/api/offers/${offerId}/select`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({selected: isSelected ? 1 : 0})
    });
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
    if (data.ok) {
        alert(`Импорт завершён! Добавлено позиций: ${data.items_added}, счетов поставщиков: ${data.invoices_added}`);
        selectProject(currentProjectId);
    } else alert('Ошибка импорта: ' + (data.error || 'неизвестный формат'));
}

async function sendSelectedToWork() {
    await fetch(`/api/projects/${currentProjectId}/to_work`, { method: 'POST' });
    alert('Выбранные позиции переданы в оплату и отслеживание (Вкладка 2)!');
    selectProject(currentProjectId);
}

async function loadKanban() {
    const res = await fetch('/api/kanban');
    const cards = await res.json();
    ['accounting', 'paid', 'transit', 'arrived'].forEach(st => document.getElementById('k-' + st).innerHTML = '');
    const today = new Date().toISOString().split('T');
    cards.forEach(c => {
        const div = document.createElement('div');
        div.className = 'k-card' + (c.arrival_date && c.arrival_date <= today ? ' overdue' : '');
        div.draggable = true;
        div.ondragstart = (e) => {
            e.dataTransfer.setData('text/plain', JSON.stringify({inv_id: c.invoice_id, old_status: c.kanban_status}));
        };
        let fileLink = c.filename ? `<a href="/api/invoice_file/${c.invoice_id}" target="_blank" style="font-size:12px;">📄 Открыть счёт</a>` : '';
        const invLabel = (c.invoice_num && c.invoice_num !== 'Из таблицы') ? ` — ${c.invoice_num}` : '';
        div.innerHTML = `
            <div style="font-size:12px;font-weight:bold;color:#1d4ed8;margin-bottom:3px;">📁 ${c.project_name}</div>
            <div style="font-size:13px;font-weight:bold;color:#0f172a;">${c.supplier}${invLabel}</div>
            <div style="font-size:12px;color:#475569;margin:4px 0;">Позиций: <b>${c.items_count}</b> | Итого: <b>${(c.total_price || 0).toFixed(2)} руб.</b></div>
            <div style="font-size:12px;margin-top:6px;">
                <input type="text" placeholder="ТК (СДЭК, ДЛ...)" value="${c.carrier || ''}" onchange="updateLogistics(${c.invoice_id}, 'carrier', this.value)" style="margin-bottom:4px;padding:4px;">
                <input type="text" placeholder="Трек-номер" value="${c.track_num || ''}" onchange="updateLogistics(${c.invoice_id}, 'track_num', this.value)" style="margin-bottom:4px;padding:4px;">
                <input type="date" value="${c.arrival_date || ''}" onchange="updateLogistics(${c.invoice_id}, 'arrival_date', this.value)" style="padding:4px;">
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;">
                ${fileLink}
                <button class="btn-green" style="padding:4px 8px;font-size:12px;" onclick="openColorModal(${c.invoice_id})">✔ Получено</button>
            </div>
        `;
        if (document.getElementById('k-' + c.kanban_status)) document.getElementById('k-' + c.kanban_status).appendChild(div);
    });
}
function allowDrop(e) { e.preventDefault(); }
async function dropCard(e, newStatus) {
    e.preventDefault();
    const raw = e.dataTransfer.getData('text/plain');
    const payload = JSON.parse(raw);
    await fetch(`/api/kanban/invoice/${payload.inv_id}/status`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({status: newStatus, old_status: payload.old_status})
    });
    loadKanban();
    loadProjects();
}
async function updateLogistics(invId, field, value) {
    await fetch(`/api/kanban/invoice/${invId}/logistics`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({field, value})
    });
}
function openColorModal(invId) {
    document.getElementById('receiveOfferId').value = invId;
    document.getElementById('colorModal').style.display = 'flex';
}
async function confirmReceive(colorClass) {
    const invId = document.getElementById('receiveOfferId').value;
    await fetch(`/api/kanban/invoice/${invId}/receive`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({color: colorClass})
    });
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
    if (activeReceivedInvId && receivedDataCache.invoices.some(x => x.invoice_id === activeReceivedInvId)) {
        selectReceivedInvoice(activeReceivedInvId);
    } else if (receivedDataCache.invoices.length > 0) {
        selectReceivedInvoice(receivedDataCache.invoices[0].invoice_id);
    } else {
        document.getElementById('receivedDetailsWorkspace').innerHTML = '<p style="color: #64748b;">Пока нет полученных счетов.</p>';
    }
}

function renderReceivedSidebar() {
    const listEl = document.getElementById('receivedInvoicesList');
    listEl.innerHTML = '';
    receivedDataCache.invoices.forEach(inv => {
        const div = document.createElement('div');
        const isAct = inv.invoice_id === activeReceivedInvId;
        div.className = `proj-item ${inv.received_color}` + (isAct ? ' active' : '');
        div.style.marginBottom = '8px';
        div.style.border = isAct ? '2px solid #2563eb' : '1px solid #cbd5e1';
        const invNum = (inv.invoice_num && inv.invoice_num !== 'Из таблицы') ? ` — ${inv.invoice_num}` : '';
        div.innerHTML = `
            <div style="font-size:12px;font-weight:bold;color:#1e3a8a;">📁 ${inv.project_name}</div>
            <div style="font-size:13px;font-weight:bold;color:#0f172a;margin-top:2px;">${inv.supplier}${invNum}</div>
            <div style="font-size:11px;color:#334155;margin-top:3px;">Позиций: <b>${inv.items_count}</b> | Сумма: <b>${(inv.total_price || 0).toFixed(2)} руб.</b></div>
        `;
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

    let html = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #e2e8f0;">
            <div>
                <div style="font-size:12px;color:#64748b;">Проект: <b>${inv.project_name}</b></div>
                <h3 style="margin:2px 0 0 0;font-size:16px;">${inv.supplier}${invNum} ${fileLink}</h3>
            </div>
            <div style="font-size:12px;">
                Цвет всего счёта:
                <span class="c-box c-1" onclick="changeInvoiceColor(${inv.invoice_id}, 'c-1')"></span>
                <span class="c-box c-2" onclick="changeInvoiceColor(${inv.invoice_id}, 'c-2')"></span>
                <span class="c-box c-3" onclick="changeInvoiceColor(${inv.invoice_id}, 'c-3')"></span>
                <span class="c-box c-4" onclick="changeInvoiceColor(${inv.invoice_id}, 'c-4')"></span>
                <span class="c-box c-5" onclick="changeInvoiceColor(${inv.invoice_id}, 'c-5')"></span>
                <span class="c-box c-6" onclick="changeInvoiceColor(${inv.invoice_id}, 'c-6')"></span>
                <span class="c-box c-7" onclick="changeInvoiceColor(${inv.invoice_id}, 'c-7')"></span>
            </div>
        </div>
        <table style="width:100%;">
            <thead>
                <tr>
                    <th>Позиция</th>
                    <th style="width:180px;">Вес (кг) / Метры</th>
                    <th style="width:140px;">Стоимость (с НДС)</th>
                    <th style="width:230px;">Цвет позиции</th>
                </tr>
            </thead>
            <tbody>
    `;
    items.forEach(r => {
        html += `
            <tr class="${r.received_color}">
                <td><b>${r.item_name}</b></td>
                <td>${r.kg || '—'} кг / <b>${r.meters || '—'} м</b></td>
                <td><b>${r.price} руб.</b></td>
                <td>
                    <span class="c-box c-1" onclick="changeColor(${r.offer_id}, 'c-1')"></span>
                    <span class="c-box c-2" onclick="changeColor(${r.offer_id}, 'c-2')"></span>
                    <span class="c-box c-3" onclick="changeColor(${r.offer_id}, 'c-3')"></span>
                    <span class="c-box c-4" onclick="changeColor(${r.offer_id}, 'c-4')"></span>
                    <span class="c-box c-5" onclick="changeColor(${r.offer_id}, 'c-5')"></span>
                    <span class="c-box c-6" onclick="changeColor(${r.offer_id}, 'c-6')"></span>
                    <span class="c-box c-7" onclick="changeColor(${r.offer_id}, 'c-7')"></span>
                </td>
            </tr>
        `;
    });
    html += `</tbody></table>`;
    document.getElementById('receivedDetailsWorkspace').innerHTML = html;
}

async function changeInvoiceColor(invId, colorClass) {
    await fetch(`/api/received/invoice/${invId}/color`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({color: colorClass})
    });
    loadReceived();
    if (currentProjectId) selectProject(currentProjectId);
}

async function changeColor(offerId, colorClass) {
    await fetch(`/api/offers/${offerId}/receive`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({color: colorClass})
    });
    loadReceived();
    if (currentProjectId) selectProject(currentProjectId);
}

async function makeBackupNow() {
    const res = await fetch('/api/backup_now', { method: 'POST' });
    const data = await res.json();
    if (data.ok) alert('Резервная копия создана в папке backups: ' + data.file);
}
loadProjects();
