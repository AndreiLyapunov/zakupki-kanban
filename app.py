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
import logging
logging.basicConfig(filename=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'debug.log'), level=logging.INFO, format='%(asctime)s %(message)s', force=True)
logging.info("=== СЕРВЕР ЗАПУЩЕН ===")

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
        
        .table-scroll { width: 100%; max-height: calc(100vh - 210px); overflow: auto; margin-top: 10px; border: 1px solid #94a3b8; border-radius: 5px; }
        table { width: max-content; border-collapse: separate; border-spacing: 0; font-size: 12px; }
        thead th { position: sticky; top: 0; background: #f1f5f9; z-index: 4; border-bottom: 2px solid #94a3b8; }
        .col-item { width: 290px; min-width: 290px; max-width: 290px; position: sticky; left: 0; background: #fff; z-index: 3; border-right: 2px solid #94a3b8 !important; box-shadow: 3px 0 6px rgba(0,0,0,0.08); }
        thead th.col-item { background: #f1f5f9; z-index: 5; }
        .col-sup { width: 240px; min-width: 240px; max-width: 240px; }
        .badge-st { display: inline-block; padding: 2px 5px; border-radius: 3px; font-size: 10px; margin: 2px 2px 0 0; font-weight: bold; }
        th, td { border: 1px solid #cbd5e1; padding: 8px; vertical-align: top; }
        th { background: #f8fafc; text-align: left; }
        .price-best { background-color: #dcfce7 !important; }
        .price-unit-best { background-color: #dbeafe !important; }
        .price-worst { background-color: #ffe4e6 !important; }
        .offer-selected { outline: 2px solid #16a34a; outline-offset: -2px; background-color: #bbf7d0 !important; }
        
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
    <div class="proj-layout">
        <div class="proj-sidebar" style="width: 340px; min-width: 340px;">
            <h3 style="margin: 0 0 10px 0; font-size: 15px;">Полученные проекты и счета</h3>
            <div id="receivedInvoicesList"></div>
        </div>
        <div class="proj-main" id="receivedDetailsWorkspace">
            <p style="color: #64748b;">Выберите полученный проект и счёт слева, чтобы посмотреть список поступивших товаров.</p>
        </div>
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

<script src="/static/main.js?v=2"></script>

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

@app.route('/api/invoices/<int:inv_id>/select_all', methods=['POST'])
def select_all_invoice(inv_id):
    sel = request.json.get('selected', 1)
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("""
            UPDATE offers SET selected=?
            WHERE invoice_id=? AND kanban_status='' AND received_color=''
            AND (price > 0 OR kg != '' OR meters != '')
        """, (sel, inv_id))
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
                clean_for_price = re.sub(r'\bГОСТ\s*[0-9-]+', '', cell_val, flags=re.IGNORECASE)
                clean_for_price = re.sub(r'[фФdD⌀]\s*[0-9]+(?:-[0-9]+)?', '', clean_for_price)
                nums = re.findall(r'[0-9]+[.,]?[0-9]*', clean_for_price.replace(' ', ''))
                price = float(nums[-1].replace(',', '.')) if nums else 0
                extra = cell_val.replace(nums[-1], '').strip(' ,;()') if nums else cell_val
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
        rows = conn.execute("""
            SELECT i.id as invoice_id, i.supplier, i.invoice_num, i.filename,
                   p.id as project_id, p.name as project_name,
                   o.kanban_status,
                   MAX(o.carrier) as carrier,
                   MAX(o.track_num) as track_num,
                   MAX(o.arrival_date) as arrival_date,
                   SUM(o.price) as total_price,
                   COUNT(o.id) as items_count
            FROM offers o
            JOIN invoices i ON o.invoice_id = i.id
            JOIN projects p ON i.project_id = p.id
            WHERE o.kanban_status != '' AND o.received_color = ''
            GROUP BY i.id, p.id, o.kanban_status
            ORDER BY p.id DESC, i.id ASC
        """).fetchall()
        return jsonify([dict(r) for r in rows])

@app.route('/api/kanban/invoice/<int:inv_id>/status', methods=['POST'])
def update_invoice_kanban_status(inv_id):
    st = request.json.get('status')
    old_st = request.json.get('old_status', '')
    with sqlite3.connect(DB_PATH) as conn:
        if old_st:
            conn.execute("UPDATE offers SET kanban_status=? WHERE invoice_id=? AND kanban_status=? AND received_color=''", (st, inv_id, old_st))
        else:
            conn.execute("UPDATE offers SET kanban_status=? WHERE invoice_id=? AND kanban_status!='' AND received_color=''", (st, inv_id))
    return jsonify({'ok': True})

@app.route('/api/kanban/invoice/<int:inv_id>/logistics', methods=['POST'])
def update_invoice_logistics(inv_id):
    field = request.json.get('field')
    val = request.json.get('value')
    if field in ['carrier', 'track_num', 'arrival_date']:
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute(f"UPDATE offers SET {field}=? WHERE invoice_id=? AND kanban_status!='' AND received_color=''", (val, inv_id))
    return jsonify({'ok': True})

@app.route('/api/kanban/invoice/<int:inv_id>/receive', methods=['POST'])
def receive_invoice_all(inv_id):
    color = request.json.get('color')
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("UPDATE offers SET received_color=?, kanban_status='received' WHERE invoice_id=? AND kanban_status!='' AND received_color=''", (color, inv_id))
    return jsonify({'ok': True})

@app.route('/api/received', methods=['GET'])
def get_received():
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        invoices_rows = conn.execute("""
            SELECT i.id as invoice_id, i.supplier, i.invoice_num, i.filename,
                   p.id as project_id, p.name as project_name,
                   MAX(o.received_color) as received_color,
                   SUM(o.price) as total_price,
                   COUNT(o.id) as items_count
            FROM offers o
            JOIN invoices i ON o.invoice_id = i.id
            JOIN projects p ON i.project_id = p.id
            WHERE o.received_color != ''
            GROUP BY i.id, p.id
            ORDER BY MAX(o.id) DESC
        """).fetchall()
        
        items_rows = conn.execute("""
            SELECT o.id as offer_id, o.invoice_id, o.price, o.kg, o.meters, o.received_color,
                   pi.name as item_name
            FROM offers o
            JOIN project_items pi ON o.item_id = pi.id
            WHERE o.received_color != ''
            ORDER BY o.id ASC
        """).fetchall()
        
        return jsonify({
            'invoices': [dict(r) for r in invoices_rows],
            'items': [dict(r) for r in items_rows]
        })

@app.route('/api/received/invoice/<int:inv_id>/color', methods=['POST'])
def change_received_invoice_color(inv_id):
    color = request.json.get('color')
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("UPDATE offers SET received_color=? WHERE invoice_id=? AND received_color != ''", (color, inv_id))
    return jsonify({'ok': True})

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


