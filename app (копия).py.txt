import os
import re
import json
import shutil
import sqlite3
import webbrowser
import subprocess
from threading import Timer
from flask import Flask, request, jsonify, render_template_string, send_file
import pdfplumber
import openpyxl

app = Flask(__name__)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, 'zakupki.db')

BACKUP_DIR = os.path.join(BASE_DIR, 'backups')
os.makedirs(BACKUP_DIR, exist_ok=True)

def create_backup(reason='auto'):
    if os.path.exists(DB_PATH):
        from datetime import datetime
        ts = datetime.now().strftime('%Y-%m-%d_%H-%M-%S')
        dst = os.path.join(BACKUP_DIR, f'zakupki_{reason}_{ts}.db')
        shutil.copy2(DB_PATH, dst)
        # Храним последние 30 резервных копий, старые удаляем
        files = sorted([os.path.join(BACKUP_DIR, fn) for fn in os.listdir(BACKUP_DIR) if fn.endswith('.db')])
        for old_f in files[:-30]:
            os.remove(old_f)
        return dst
    return ''

def init_db():
    create_backup('startup')
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute('''
            CREATE TABLE IF NOT EXISTS projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                folder_path TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS project_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                req_meters TEXT
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS invoices (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL,
                supplier TEXT NOT NULL,
                invoice_num TEXT,
                delivery_cost REAL DEFAULT 0,
                notes TEXT,
                filename TEXT
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS offers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                invoice_id INTEGER NOT NULL,
                item_id INTEGER NOT NULL,
                price REAL DEFAULT 0,
                kg TEXT,
                meters TEXT,
                selected INTEGER DEFAULT 0,
                kanban_status TEXT DEFAULT '',
                carrier TEXT DEFAULT '',
                track_num TEXT DEFAULT '',
                arrival_date TEXT DEFAULT '',
                received_color TEXT DEFAULT ''
            )
        ''')

def make_safe_folder(name):
    clean = re.sub(r'[^\w\s-]', '', name).strip().replace(' ', '_')
    return clean if clean else 'project'

def read_spreadsheet_rows(filepath):
    _, ext = os.path.splitext(filepath)
    ext = ext.lower()
    rows = []
    if ext in ['.xlsx', '.xlsm']:
        wb = openpyxl.load_workbook(filepath, data_only=True)
        ws = wb.active
        for row in ws.iter_rows(values_only=True):
            rows.append([str(c).strip() if c is not None else '' for c in row])
    elif ext == '.xls':
        import xlrd
        wb = xlrd.open_workbook(filepath)
        sheet = wb.sheet_by_index(0)
        for r in range(sheet.nrows):
            rows.append([str(sheet.cell_value(r, c)).strip() for c in range(sheet.ncols)])
    elif ext == '.ods':
        from odf.opendocument import load
        from odf.table import Table, TableRow, TableCell
        from odf.text import P
        doc = load(filepath)
        tables = doc.spreadsheet.getElementsByType(Table)
        if tables:
            for row in tables[0].getElementsByType(TableRow):
                r_vals = []
                for cell in row.getElementsByType(TableCell):
                    rep = int(cell.getAttribute('numbercolumnsrepeated') or 1)
                    ps = cell.getElementsByType(P)
                    txt = " ".join([str(p.firstChild.data) for p in ps if p.firstChild and hasattr(p.firstChild, 'data')]).strip()
                    for _ in range(min(rep, 30)):
                        r_vals.append(txt)
                rows.append(r_vals)
    return rows

def extract_text_from_file(filepath):
    _, ext = os.path.splitext(filepath)
    ext = ext.lower()
    if ext in ['.jpg', '.jpeg', '.png', '.bmp', '.tif', '.tiff']:
        return "", True
    if ext == '.pdf':
        text_parts = []
        try:
            with pdfplumber.open(filepath) as pdf:
                for page in pdf.pages:
                    t = page.extract_text()
                    if t:
                        text_parts.append(t)
        except Exception:
            return "", True
        full_text = "\n".join(text_parts).strip()
        if len(full_text) < 20:
            return "", True
        return full_text, False
    if ext in ['.xlsx', '.xlsm', '.xls', '.ods']:
        try:
            rows = read_spreadsheet_rows(filepath)
            text_parts = [" | ".join([c for c in r if c]) for r in rows if any(r)]
            full_text = "\n".join(text_parts).strip()
            return (full_text, False) if full_text else ("", True)
        except Exception:
            return "", True
    return "", True

HTML_TEMPLATE = '''
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <title>Система закупок предприятия</title>
    <style>
        * { box-sizing: border-box; }
        body { font-family: Arial, sans-serif; background: #f0f2f5; margin: 0; color: #222; }
        .topbar { background: #1e293b; color: #fff; padding: 12px 20px; display: flex; justify-content: space-between; align-items: center; }
        .topbar h2 { margin: 0; font-size: 18px; }
        .tabs { display: flex; gap: 10px; }
        .tab-btn { background: #334155; color: #fff; border: none; padding: 8px 16px; border-radius: 5px; cursor: pointer; font-size: 14px; }
        .tab-btn.active { background: #2563eb; font-weight: bold; }
        
        .view { display: none; padding: 15px; }
        .view.active { display: block; }
        
        .proj-layout { display: flex; gap: 15px; align-items: flex-start; }
        .proj-sidebar { width: 270px; min-width: 270px; background: #fff; border-radius: 8px; padding: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        .proj-item { padding: 10px; border-bottom: 1px solid #eee; cursor: pointer; border-radius: 4px; }
        .proj-item:hover { background: #f1f5f9; }
        .proj-item.active { background: #dbeafe; font-weight: bold; color: #1d4ed8; }
        .proj-main { flex: 1; background: #fff; border-radius: 8px; padding: 15px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); overflow-x: auto; }
        
        button { background: #2563eb; color: #fff; border: none; padding: 7px 14px; border-radius: 4px; cursor: pointer; font-size: 13px; }
        button:hover { background: #1d4ed8; }
        .btn-green { background: #16a34a; }
        .btn-green:hover { background: #15803d; }
        .btn-gray { background: #64748b; }
        
        .table-scroll { width: 100%; overflow-x: auto; margin-top: 10px; border: 1px solid #cbd5e1; }
        table { width: max-content; border-collapse: collapse; font-size: 12px; }
        .col-item { width: 290px; min-width: 290px; max-width: 290px; position: sticky; left: 0; background: #fff; z-index: 2; }
        th.col-item { background: #f8fafc; z-index: 3; }
        .col-sup { width: 240px; min-width: 240px; max-width: 240px; }
        .badge-st { display: inline-block; padding: 2px 5px; border-radius: 3px; font-size: 10px; margin: 2px 2px 0 0; font-weight: bold; }
        th, td { border: 1px solid #cbd5e1; padding: 8px; vertical-align: top; }
        th { background: #f8fafc; text-align: left; }
        .offer-selected { background: #dcfce7 !important; }
        
        .kanban-board { display: flex; gap: 15px; overflow-x: auto; align-items: flex-start; min-height: 80vh; }
        .k-col { background: #e2e8f0; border-radius: 8px; width: 300px; min-width: 300px; padding: 10px; }
        .k-col h3 { margin: 0 0 10px 0; font-size: 15px; text-align: center; padding-bottom: 6px; border-bottom: 2px solid #94a3b8; }
        .k-list { min-height: 450px; }
        .k-card { background: #fff; border-radius: 6px; padding: 10px; margin-bottom: 10px; box-shadow: 0 1px 2px rgba(0,0,0,0.15); border-left: 4px solid #2563eb; }
        .k-card.overdue { border: 2px solid #dc2626; }
        
        .c-box { display: inline-block; width: 24px; height: 24px; border-radius: 4px; cursor: pointer; border: 1px solid #666; margin-right: 5px; }
        .c-1 { background-color: #bbf7d0; }
        .c-2 { background-color: #fef08a; }
        .c-3 { background-color: #bfdbfe; }
        .c-4 { background-color: #fed7aa; }
        .c-5 { background-color: #e9d5ff; }
        .c-6 { background-color: #fbcfe8; }
        .c-7 { background-color: #e2e8f0; }

        .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); justify-content: center; align-items: center; z-index: 1000; }
        .modal-box { background: #fff; padding: 20px; border-radius: 8px; width: 650px; max-width: 95%; max-height: 90vh; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
        input[type="text"], input[type="number"], input[type="date"], textarea { width: 100%; padding: 7px; border: 1px solid #cbd5e1; border-radius: 4px; }
        .scan-alert { background: #fef2f2; border: 1px solid #dc2626; color: #991b1b; padding: 10px; border-radius: 5px; font-weight: bold; display: none; }
    </style>
</head>
<body>

<div class="topbar">
    <h2>Управление закупками по проектам</h2>
    <div class="tabs">
        <button class="tab-btn" style="background:#0f766e;" onclick="makeBackupNow()" title="Сохранить копию базы данных">💾 Резервная копия</button>
        <button class="tab-btn active" onclick="switchTab('projects', this)">1. Проекты и сравнение счетов</button>
        <button class="tab-btn" onclick="switchTab('kanban', this)">2. В работе (Оплата и доставка)</button>
        <button class="tab-btn" onclick="switchTab('received', this)">3. Полученные товары</button>
    </div>
</div>

<!-- ВКЛАДКА 1: ПРОЕКТЫ -->
<div id="view-projects" class="view active">
    <div class="proj-layout">
        <div class="proj-sidebar">
            <button style="width: 100%; margin-bottom: 10px;" onclick="openProjectModal()">+ Новый проект</button>
            <div id="projectList"></div>
        </div>
        <div class="proj-main" id="projectWorkspace">
            <p style="color: #64748b;">Выберите проект слева или создайте новый, чтобы загрузить список закупки и сравнить счета.</p>
        </div>
    </div>
</div>

<!-- ВКЛАДКА 2: КАНБАН -->
<div id="view-kanban" class="view">
    <div class="kanban-board">
        <div class="k-col" ondrop="dropCard(event, 'accounting')" ondragover="allowDrop(event)">
            <h3>Передано в бухгалтерию</h3>
            <div class="k-list" id="k-accounting"></div>
        </div>
        <div class="k-col" ondrop="dropCard(event, 'paid')" ondragover="allowDrop(event)">
            <h3>Оплачено / Ждём отгрузку</h3>
            <div class="k-list" id="k-paid"></div>
        </div>
        <div class="k-col" ondrop="dropCard(event, 'transit')" ondragover="allowDrop(event)">
            <h3>В пути</h3>
            <div class="k-list" id="k-transit"></div>
        </div>
        <div class="k-col" ondrop="dropCard(event, 'arrived')" ondragover="allowDrop(event)">
            <h3>Прибыло / На приёмке</h3>
            <div class="k-list" id="k-arrived"></div>
        </div>
    </div>
</div>

<!-- ВКЛАДКА 3: ПОЛУЧЕННЫЕ ТОВАРЫ -->
<div id="view-received" class="view">
    <div style="background: #fff; padding: 15px; border-radius: 8px;">
        <h3>Реестр полученных товаров</h3>
        <table>
            <thead>
                <tr>
                    <th>Проект</th>
                    <th>Поставщик и Счёт</th>
                    <th>Позиция</th>
                    <th>Вес (кг) / Метры</th>
                    <th>Стоимость (с НДС)</th>
                    <th>Цвет отметки (нажмите для смены)</th>
                </tr>
            </thead>
            <tbody id="receivedTableBody"></tbody>
        </table>
    </div>
</div>

<!-- МОДАЛКА: НОВЫЙ ПРОЕКТ -->
<div class="modal" id="projectModal">
    <div class="modal-box">
        <h3>Создать новый проект</h3>
        <input type="text" id="newProjName" placeholder="Название проекта (например: Заказ 15 - Оснастка)">
        <label style="font-size: 13px; font-weight: bold;">Папка для сохранения счетов проекта:</label>
        <div style="display: flex; gap: 8px;">
            <input type="text" id="newProjFolder" placeholder="Нажмите «Выбрать папку...» или оставьте пустым для автосоздания">
            <button type="button" style="white-space: nowrap;" onclick="browseFolder()">📁 Выбрать папку...</button>
        </div>

        <label style="font-size: 13px;">Список товаров для закупки (каждая позиция с новой строки, желательно указать метры):</label>
        <textarea id="newProjItems" rows="6" placeholder="Сталь 45 круг D85 - 1 м&#10;Капролон D80 - 1 м&#10;Сталь Х12МФ D35 - 3 м"></textarea>
        <div style="display: flex; justify-content: flex-end; gap: 10px;">
            <button class="btn-gray" onclick="closeModal('projectModal')">Отмена</button>
            <button onclick="createProject()">Создать проект</button>
        </div>
    </div>
</div>

<!-- МОДАЛКА: ДОБАВИТЬ СЧЁТ -->
<div class="modal" id="invoiceModal">
    <div class="modal-box">
        <h3>Добавить счёт поставщика</h3>
        <input type="text" id="invSupplier" placeholder="Поставщик (на русском, как в счёте: ООО НПП «АНЭП-ЮФО»)">
        <input type="text" id="invNum" placeholder="Номер и дата счёта (например: Счёт № 145 от 20.11.2026)">
        
        <label style="font-size: 13px; font-weight: bold;">1. Загрузить файл счёта (PDF, Excel или скан — сохранится в папку проекта):</label>
        <input type="file" id="invFile" onchange="parseInvoiceFile()">
        <div id="scanWarning" class="scan-alert">
            ⚠️ Внимание: Это скан или картинка без текстового слоя! Распознайте его онлайн и вставьте полученный текст в поле ниже.
        </div>

        <label style="font-size: 13px; font-weight: bold;">2. Распознанный текст счёта (или вставьте сюда текст из письма/онлайн-распознавания):</label>
        <textarea id="invExtractedText" rows="5" placeholder="Здесь появится текст из PDF/Excel, или вставьте текст счёта вручную..."></textarea>

        <div style="background: #f1f5f9; padding: 8px; border-radius: 5px; display: flex; gap: 10px; align-items: center;">
            <span style="font-size: 13px;">Калькулятор НДС:</span>
            <input type="number" id="vatInput" placeholder="Цена без НДС" style="width: 140px;">
            <button type="button" onclick="calcVat(1.20)">+20% НДС</button>
            <button type="button" onclick="calcVat(1.22)">+22% НДС</button>
            <span id="vatResult" style="font-weight: bold; color: #1d4ed8;"></span>
        </div>

        <div id="invItemsContainer"></div>

        <input type="number" id="invDelivery" placeholder="Стоимость доставки до терминала (руб.)">
        <input type="text" id="invNotes" placeholder="Примечания (страна происхождения, ГОСТ, наличие на складе)">

        <div style="display: flex; justify-content: flex-end; gap: 10px;">
            <button class="btn-gray" onclick="closeModal('invoiceModal')">Отмена</button>
            <button class="btn-green" onclick="saveInvoice()">Сохранить счёт в таблицу</button>
        </div>
    </div>
</div>

<!-- МОДАЛКА: ВЫБОР 7 ЦВЕТОВ ПРИ ПОЛУЧЕНИИ -->
<div class="modal" id="colorModal">
    <div class="modal-box" style="width: 380px;">
        <h3>Товар получен! Выберите цвет отметки:</h3>
        <input type="hidden" id="receiveOfferId">
        <div style="display: flex; justify-content: center; padding: 15px 0;">
            <span class="c-box c-1" onclick="confirmReceive('c-1')" title="Зелёный"></span>
            <span class="c-box c-2" onclick="confirmReceive('c-2')" title="Жёлтый"></span>
            <span class="c-box c-3" onclick="confirmReceive('c-3')" title="Голубой"></span>
            <span class="c-box c-4" onclick="confirmReceive('c-4')" title="Оранжевый"></span>
            <span class="c-box c-5" onclick="confirmReceive('c-5')" title="Фиолетовый"></span>
            <span class="c-box c-6" onclick="confirmReceive('c-6')" title="Розовый"></span>
            <span class="c-box c-7" onclick="confirmReceive('c-7')" title="Серый"></span>
        </div>
        <button class="btn-gray" onclick="closeModal('colorModal')">Отмена</button>
    </div>
</div>

<script>
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
    currentProjectId = id;
    loadProjects();
    const res = await fetch(`/api/projects/${id}`);
    currentProjectData = await res.json();
    renderComparisonTable();
}

function renderComparisonTable() {
    const ws = document.getElementById('projectWorkspace');
    const p = currentProjectData.project;
    const items = currentProjectData.items;
    const invoices = currentProjectData.invoices;
    const offers = currentProjectData.offers;
    const fList = currentProjectData.folder_files || [];

    let filesHtml = fList.length ? `<div style="margin-top:8px;padding:6px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:5px;"><div style="font-size:11px;font-weight:bold;color:#475569;margin-bottom:4px;">📂 Файлы в проекте (${fList.length}):</div><div style="display:flex;flex-wrap:wrap;gap:5px;">` + fList.map(fn => `<a href="/api/projects/${p.id}/folder_file/${encodeURIComponent(fn)}" target="_blank" style="background:#fff;padding:2px 6px;border:1px solid #cbd5e1;border-radius:3px;text-decoration:none;color:#1e293b;font-size:11px;">📄 ${fn}</a>`).join('') + `</div></div>` : '';

    let html = `<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;"><div><h3 style="margin:0;font-size:16px;">${p.name}</h3><small style="color:#64748b;font-size:11px;">Папка: ${p.folder_path}</small></div><div style="display:flex;gap:8px;flex-shrink:0;"><input type="file" id="importExcelInput" accept=".xlsx,.xlsm,.xls,.ods" style="display:none" onchange="importComparisonTable()"><button style="background:#0284c7;" onclick="document.getElementById('importExcelInput').click()">📥 Импорт таблицы</button><button onclick="openInvoiceModal()">+ Добавить счёт</button><button class="btn-green" onclick="sendSelectedToWork()">✔ В работу</button></div></div>${filesHtml}<div class="table-scroll"><table><thead><tr><th class="col-item">Заказываемый материал (Заявка)</th>`;

    invoices.forEach(inv => {
        let fl = inv.filename ? `<div style="margin-top:3px;"><a href="/api/invoice_file/${inv.id}" target="_blank" style="font-size:11px;color:#2563eb;">📄 Открыть счёт</a></div>` : '';
        html += `<th class="col-sup"><div>${inv.supplier}</div><div style="font-weight:normal;font-size:11px;color:#475569;">${inv.invoice_num || ''}</div>${fl}</th>`;
    });
    html += `</tr></thead><tbody>`;

    items.forEach(item => {
        const rec = offers.find(o => o.item_id === item.id && o.received_color);
        html += `<tr class="${rec ? rec.received_color : ''}"><td class="col-item" style="${rec ? 'background:inherit;' : ''}"><b>${item.name}</b></td>`;
        invoices.forEach(inv => {
            const off = offers.find(o => o.invoice_id === inv.id && o.item_id === item.id);
            if (off && (off.price > 0 || off.kg || off.meters)) {
                const st = off.kanban_status ? `<span style="color:#15803d;font-weight:bold;font-size:11px;"> [В работе]</span>` : '';
                html += `<td class="col-sup offer-cell ${off.selected ? 'offer-selected' : ''}"><label style="cursor:pointer;font-weight:bold;font-size:11px;"><input type="checkbox" ${off.selected ? 'checked' : ''} ${off.kanban_status ? 'disabled' : ''} onchange="toggleOffer(${off.id}, this.checked)"> Выбрать</label>${st}<div style="margin-top:2px;">Цена с НДС: <b>${off.price} руб.</b></div><div style="color:#475569;">Вес: ${off.kg || '—'} кг | Метры/инфо: <b>${off.meters || '—'}</b></div></td>`;
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
        div.ondragstart = (e) => e.dataTransfer.setData('text/plain', c.offer_id);
        let fileLink = c.filename ? `<a href="/api/invoice_file/${c.invoice_id}" target="_blank" style="font-size:12px;">📄 Счёт</a>` : '';
        div.innerHTML = `<div style="font-size:11px;color:#64748b;">Проект: ${c.project_name}</div><div style="font-weight:bold;margin:3px 0;">${c.supplier} (${c.invoice_num})</div><div style="background:#f1f5f9;padding:5px;border-radius:4px;font-size:13px;margin:5px 0;"><b>${c.item_name}</b><br>Вес: ${c.kg || '—'} кг | Метры: <b>${c.meters || '—'} м</b><br>Сумма: ${c.price} руб.</div><div style="font-size:12px;margin-top:5px;"><input type="text" placeholder="ТК" value="${c.carrier || ''}" onchange="updateLogistics(${c.offer_id}, 'carrier', this.value)" style="margin-bottom:4px;padding:4px;"><input type="text" placeholder="Трек-номер" value="${c.track_num || ''}" onchange="updateLogistics(${c.offer_id}, 'track_num', this.value)" style="margin-bottom:4px;padding:4px;"><input type="date" value="${c.arrival_date || ''}" onchange="updateLogistics(${c.offer_id}, 'arrival_date', this.value)" style="padding:4px;"></div><div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;">${fileLink}<button class="btn-green" style="padding:4px 8px;font-size:12px;" onclick="openColorModal(${c.offer_id})">✔ Получено</button></div>`;
        if (document.getElementById('k-' + c.kanban_status)) document.getElementById('k-' + c.kanban_status).appendChild(div);
    });
}
function allowDrop(e) { e.preventDefault(); }
async function dropCard(e, newStatus) {
    e.preventDefault();
    const offerId = e.dataTransfer.getData('text/plain');
    await fetch(`/api/offers/${offerId}/status`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({status: newStatus}) });
    loadKanban();
}
async function updateLogistics(offerId, field, value) {
    await fetch(`/api/offers/${offerId}/logistics`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({field, value}) });
}
function openColorModal(offerId) { document.getElementById('receiveOfferId').value = offerId; document.getElementById('colorModal').style.display = 'flex'; }
async function confirmReceive(colorClass) {
    const offerId = document.getElementById('receiveOfferId').value;
    await fetch(`/api/offers/${offerId}/receive`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({color: colorClass}) });
    closeModal('colorModal'); loadKanban(); if (currentProjectId) selectProject(currentProjectId);
}
async function loadReceived() {
    const res = await fetch('/api/received');
    const rows = await res.json();
    const tbody = document.getElementById('receivedTableBody');
    tbody.innerHTML = '';
    rows.forEach(r => {
        tbody.innerHTML += `<tr class="${r.received_color}"><td>${r.project_name}</td><td>${r.supplier} (${r.invoice_num})</td><td><b>${r.item_name}</b></td><td>${r.kg || '—'} кг / <b>${r.meters || '—'} м</b></td><td>${r.price} руб.</td><td><span class="c-box c-1" onclick="changeColor(${r.offer_id}, 'c-1')"></span><span class="c-box c-2" onclick="changeColor(${r.offer_id}, 'c-2')"></span><span class="c-box c-3" onclick="changeColor(${r.offer_id}, 'c-3')"></span><span class="c-box c-4" onclick="changeColor(${r.offer_id}, 'c-4')"></span><span class="c-box c-5" onclick="changeColor(${r.offer_id}, 'c-5')"></span><span class="c-box c-6" onclick="changeColor(${r.offer_id}, 'c-6')"></span><span class="c-box c-7" onclick="changeColor(${r.offer_id}, 'c-7')"></span></td></tr>`;
    });
}
async function changeColor(offerId, colorClass) {
    await fetch(`/api/offers/${offerId}/receive`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({color: colorClass}) });
    loadReceived();
}
async function makeBackupNow() {
    const res = await fetch('/api/backup_now', { method: 'POST' });
    const data = await res.json();
    if (data.ok) alert('Резервная копия создана в папке backups:\n' + data.file);
}
loadProjects();
</script>

</body>
</html>
'''

@app.route('/')
def index():
    return render_template_string(HTML_TEMPLATE)

@app.route('/api/select_folder', methods=['GET'])
def select_folder():
    try:
        res = subprocess.check_output(
            ['zenity', '--file-selection', '--directory', '--title=Выберите папку для проекта'],
            text=True
        ).strip()
        return jsonify({'folder': res})
    except Exception:
        return jsonify({'folder': ''})

@app.route('/api/invoice_file/<int:inv_id>')
def serve_invoice_file(inv_id):
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute('''
            SELECT i.filename, p.folder_path FROM invoices i
            JOIN projects p ON i.project_id = p.id
            WHERE i.id=?
        ''', (inv_id,)).fetchone()
        if row and row['filename']:
            full_path = os.path.join(row['folder_path'], row['filename'])
            if os.path.exists(full_path):
                return send_file(full_path)
    return "Файл не найден", 404

@app.route('/api/projects', methods=['GET'])
def get_projects():
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute('SELECT * FROM projects ORDER BY created_at DESC, id DESC').fetchall()
        res = []
        for r in rows:
            d = dict(r)
            stats = conn.execute("SELECT o.kanban_status, o.received_color, COUNT(*) as cnt FROM offers o JOIN invoices i ON o.invoice_id = i.id WHERE i.project_id = ? AND (o.kanban_status != '' OR o.received_color != '') GROUP BY o.kanban_status, o.received_color", (d['id'],)).fetchall()
            c_acc = c_paid = c_trans = c_rec = 0
            for st in stats:
                if st['received_color'] or st['kanban_status'] == 'received': c_rec += st['cnt']
                elif st['kanban_status'] == 'accounting': c_acc += st['cnt']
                elif st['kanban_status'] == 'paid': c_paid += st['cnt']
                elif st['kanban_status'] in ('transit', 'arrived'): c_trans += st['cnt']
            d['stats'] = {'accounting': c_acc, 'paid': c_paid, 'transit': c_trans, 'received': c_rec}
            res.append(d)
        return jsonify(res)

@app.route('/api/projects', methods=['POST'])
def create_project():
    data = request.json
    name = data['name']
    folder_path = data.get('folder_path', '').strip()
    if not folder_path:
        folder_path = os.path.join(BASE_DIR, make_safe_folder(name))
    os.makedirs(folder_path, exist_ok=True)

    with sqlite3.connect(DB_PATH) as conn:
        cur = conn.execute('INSERT INTO projects (name, folder_path) VALUES (?, ?)', (name, folder_path))
        proj_id = cur.lastrowid
        for line in data['items'].splitlines():
            line = line.strip()
            if line:
                conn.execute('INSERT INTO project_items (project_id, name) VALUES (?, ?)', (proj_id, line))
    return jsonify({'id': proj_id})

@app.route('/api/projects/<int:proj_id>', methods=['GET'])
def get_project_details(proj_id):
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        proj = dict(conn.execute('SELECT * FROM projects WHERE id=?', (proj_id,)).fetchone())
        items = [dict(r) for r in conn.execute('SELECT * FROM project_items WHERE project_id=?', (proj_id,)).fetchall()]
        invoices = [dict(r) for r in conn.execute('SELECT * FROM invoices WHERE project_id=?', (proj_id,)).fetchall()]
        offers = [dict(r) for r in conn.execute('''
            SELECT o.* FROM offers o
            JOIN invoices i ON o.invoice_id = i.id
            WHERE i.project_id=?
        ''', (proj_id,)).fetchall()]
    return jsonify({'project': proj, 'items': items, 'invoices': invoices, 'offers': offers})

def detect_services_from_text(text):
    cut_price = ''
    deliv_price = ''
    for line in text.splitlines():
        low = line.lower()
        nums = re.findall(r'[0-9]{1,3}(?:[\s\u00a0]?[0-9]{3})*[.,][0-9]{2}', line)
        if not nums:
            nums = re.findall(r'[0-9]+[.,]?[0-9]*', line)
        clean_nums = [n.replace(' ', '').replace('\u00a0', '').replace(',', '.') for n in nums]
        val = clean_nums[-1] if clean_nums else ''
        if val and any(k in low for k in ['резка', 'порезка', 'раскрой']) and not cut_price:
            cut_price = val
        if val and any(k in low for k in ['доставк', 'транспортн', 'терминал']) and not deliv_price:
            deliv_price = val
    return cut_price, deliv_price

@app.route('/api/parse_preview', methods=['POST'])
def parse_preview():
    if 'file' not in request.files:
        return jsonify({'is_scan': True, 'text': '', 'cut_price': '', 'deliv_price': ''})
    f = request.files['file']
    temp_path = os.path.join(BASE_DIR, 'temp_preview_' + f.filename)
    f.save(temp_path)
    text, is_scan = extract_text_from_file(temp_path)
    if os.path.exists(temp_path):
        os.remove(temp_path)
    cut_price, deliv_price = ('', '') if is_scan else detect_services_from_text(text)
    return jsonify({'is_scan': is_scan, 'text': text, 'cut_price': cut_price, 'deliv_price': deliv_price})

@app.route('/api/invoices', methods=['POST'])
def add_invoice():
    proj_id = request.form.get('project_id')
    supplier = request.form.get('supplier')
    invoice_num = request.form.get('invoice_num')
    delivery_cost = request.form.get('delivery_cost', 0)
    notes = request.form.get('notes', '')
    offers = json.loads(request.form.get('offers', '[]'))

    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        proj = conn.execute('SELECT folder_path FROM projects WHERE id=?', (proj_id,)).fetchone()
        folder_path = proj['folder_path']
        os.makedirs(folder_path, exist_ok=True)

        filename = ''
        if 'file' in request.files:
            f = request.files['file']
            if f.filename:
                safe_file = f"{supplier}_{invoice_num}_{f.filename}".replace(' ', '_').replace('/', '-')
                f.save(os.path.join(folder_path, safe_file))
                filename = safe_file

        cur = conn.execute('''
            INSERT INTO invoices (project_id, supplier, invoice_num, delivery_cost, notes, filename)
            VALUES (?, ?, ?, ?, ?, ?)
        ''', (proj_id, supplier, invoice_num, delivery_cost, notes, filename))
        inv_id = cur.lastrowid

        for off in offers:
            conn.execute('''
                INSERT INTO offers (invoice_id, item_id, price, kg, meters)
                VALUES (?, ?, ?, ?, ?)
            ''', (inv_id, off['item_id'], off['price'], off['kg'], off['meters']))
    return jsonify({'ok': True})

@app.route('/api/offers/<int:offer_id>/select', methods=['POST'])
def select_offer(offer_id):
    sel = request.json.get('selected', 0)
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute('UPDATE offers SET selected=? WHERE id=?', (sel, offer_id))
    return jsonify({'ok': True})

@app.route('/api/projects/<int:proj_id>/import_table', methods=['POST'])
def import_comparison_table(proj_id):
    if 'file' not in request.files:
        return jsonify({'ok': False, 'error': 'Файл не выбран'})
    f = request.files['file']
    temp_path = os.path.join(BASE_DIR, 'temp_import_' + f.filename)
    f.save(temp_path)
    try:
        rows = read_spreadsheet_rows(temp_path)
    except Exception as e:
        if os.path.exists(temp_path):
            os.remove(temp_path)
        return jsonify({'ok': False, 'error': str(e)})
    if os.path.exists(temp_path):
        os.remove(temp_path)

    non_empty_rows = [r for r in rows if any(c.strip() for c in r)]
    if len(non_empty_rows) < 2:
        return jsonify({'ok': False, 'error': 'В таблице слишком мало строк'})

    header = next(iter(non_empty_rows))
    suppliers = []
    for col_idx in range(1, len(header)):
        sup_name = header[col_idx].strip()
        if sup_name and not sup_name.lower().startswith('заказ'):
            suppliers.append((col_idx, sup_name))

    if not suppliers:
        return jsonify({'ok': False, 'error': 'Не найдены столбцы поставщиков в первой строке'})

    items_added = 0
    invoices_added = 0
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        proj = conn.execute('SELECT folder_path FROM projects WHERE id=?', (proj_id,)).fetchone()
        folder_files = []
        if proj and os.path.isdir(proj['folder_path']):
            folder_files = [fn for fn in os.listdir(proj['folder_path']) if os.path.isfile(os.path.join(proj['folder_path'], fn))]

        inv_map = {}
        for col_idx, sup_name in suppliers:
            # Автоматически ищем подходящий файл счёта в папке проекта по названию фирмы
            matched_file = ''
            words = [w.lower() for w in re.findall(r'[а-яА-Яa-zA-Z]{4,}', sup_name) if w.lower() not in ('ооо', 'нпп', 'счет', 'счёт', 'текст', 'точка')]
            for fn in folder_files:
                if fn == f.filename:
                    continue
                clean_fn = re.sub(r'[^а-яА-Яa-zA-Z0-9]', '', fn.lower())
                if any(w in fn.lower() for w in words) or any(w in clean_fn for w in words):
                    matched_file = fn
                    break
            cur = conn.execute('INSERT INTO invoices (project_id, supplier, invoice_num, filename) VALUES (?, ?, ?, ?)',
                               (proj_id, sup_name, 'Из таблицы', matched_file))
            inv_map[col_idx] = cur.lastrowid
            invoices_added += 1

        existing_items = {row['name']: row['id'] for row in conn.execute('SELECT name, id FROM project_items WHERE project_id=?', (proj_id,)).fetchall()}

        for r in non_empty_rows[1:]:
            item_name = next(iter(r), '').strip()
            low = item_name.lower()

            # Нижние строки без названия в 1-м столбце -> записываем в Примечания
            if not item_name:
                for col_idx, inv_id in inv_map.items():
                    val = r[col_idx].strip() if col_idx < len(r) else ''
                    if val:
                        row_n = conn.execute('SELECT notes FROM invoices WHERE id=?', (inv_id,)).fetchone()
                        old_n = (row_n['notes'] if row_n else '') or ''
                        new_n = (old_n + '; ' + val).strip('; ')
                        conn.execute('UPDATE invoices SET notes=? WHERE id=?', (new_n, inv_id))
                continue

            if low.startswith('итого') or low.startswith('всего'):
                continue

            if 'примечан' in low or 'услов' in low or 'срок' in low:
                for col_idx, inv_id in inv_map.items():
                    val = r[col_idx].strip() if col_idx < len(r) else ''
                    if val:
                        conn.execute('UPDATE invoices SET notes=? WHERE id=?', (val, inv_id))
                continue

            if item_name in existing_items:
                item_id = existing_items[item_name]
            else:
                cur = conn.execute('INSERT INTO project_items (project_id, name) VALUES (?, ?)', (proj_id, item_name))
                item_id = cur.lastrowid
                existing_items[item_name] = item_id
                items_added += 1

            for col_idx, inv_id in inv_map.items():
                cell_val = r[col_idx].strip() if col_idx < len(r) else ''
                if not cell_val:
                    continue
                nums = re.findall(r'[0-9]+[.,]?[0-9]*', cell_val.replace(' ', ''))
                price = float(next(iter(nums)).replace(',', '.')) if nums else 0
                extra = re.sub(r'^[0-9\s.,]+', '', cell_val).strip()
                conn.execute('INSERT INTO offers (invoice_id, item_id, price, kg, meters) VALUES (?, ?, ?, ?, ?)',
                             (inv_id, item_id, price, '', extra))

    return jsonify({'ok': True, 'items_added': items_added, 'invoices_added': invoices_added})

@app.route('/api/projects/<int:proj_id>/to_work', methods=['POST'])
def send_to_work(proj_id):
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute('''
            UPDATE offers SET kanban_status='accounting'
            WHERE selected=1 AND kanban_status='' AND received_color=''
            AND invoice_id IN (SELECT id FROM invoices WHERE project_id=?)
        ''', (proj_id,))
    return jsonify({'ok': True})

@app.route('/api/kanban', methods=['GET'])
def get_kanban():
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute('''
            SELECT o.id as offer_id, o.price, o.kg, o.meters, o.kanban_status,
                   o.carrier, o.track_num, o.arrival_date,
                   pi.name as item_name,
                   i.id as invoice_id, i.supplier, i.invoice_num, i.filename,
                   p.name as project_name
            FROM offers o
            JOIN project_items pi ON o.item_id = pi.id
            JOIN invoices i ON o.invoice_id = i.id
            JOIN projects p ON i.project_id = p.id
            WHERE o.kanban_status != '' AND o.received_color = ''
        ''').fetchall()
        return jsonify([dict(r) for r in rows])

@app.route('/api/offers/<int:offer_id>/status', methods=['POST'])
def update_kanban_status(offer_id):
    st = request.json.get('status')
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute('UPDATE offers SET kanban_status=? WHERE id=?', (st, offer_id))
    return jsonify({'ok': True})

@app.route('/api/offers/<int:offer_id>/logistics', methods=['POST'])
def update_logistics(offer_id):
    field = request.json.get('field')
    val = request.json.get('value')
    if field in ['carrier', 'track_num', 'arrival_date']:
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute(f'UPDATE offers SET {field}=? WHERE id=?', (val, offer_id))
    return jsonify({'ok': True})

@app.route('/api/offers/<int:offer_id>/receive', methods=['POST'])
def receive_offer(offer_id):
    color = request.json.get('color')
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("UPDATE offers SET received_color=?, kanban_status='received' WHERE id=?", (color, offer_id))
    return jsonify({'ok': True})

@app.route('/api/received', methods=['GET'])
def get_received():
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute('''
            SELECT o.id as offer_id, o.price, o.kg, o.meters, o.received_color,
                   pi.name as item_name,
                   i.supplier, i.invoice_num,
                   p.name as project_name
            FROM offers o
            JOIN project_items pi ON o.item_id = pi.id
            JOIN invoices i ON o.invoice_id = i.id
            JOIN projects p ON i.project_id = p.id
            WHERE o.received_color != ''
            ORDER BY o.id DESC
        ''').fetchall()
        return jsonify([dict(r) for r in rows])

def open_browser():
    url = 'http://' + '127.0.0.1' + ':5055/'
    if shutil.which('opera'):
        subprocess.Popen(['opera', url])
    elif shutil.which('google-chrome'):
        subprocess.Popen(['google-chrome', url])
    else:
        webbrowser.open_new(url)

@app.route('/api/backup_now', methods=['POST'])
def api_backup_now():
    path = create_backup('manual')
    return jsonify({'ok': True, 'file': os.path.basename(path)})

if __name__ == '__main__':
    init_db()
    # Timer(1.0, open_browser).start()
    app.run(host='127.0.0.1', port=5055, debug=False)


