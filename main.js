const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// حل لمنع الجليتش والـ Lag في بعض كروت الشاشة
app.disableHardwareAcceleration();

let mainWindow;
let db;

// تحديد مسار قاعدة البيانات
const dbPath = path.join(app.getPath('userData'), 'smart_accountant.db');

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    initDatabase();

    const row = db.prepare("SELECT COUNT(*) as count FROM company_profile").get();
    
    if (row && row.count > 0) {
        mainWindow.loadFile('index.html');
    } else {
        mainWindow.loadFile('setup.html');
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

function initDatabase() {
    db = new Database(dbPath);

    // 1. جدول بروفايل المؤسسة
    db.prepare(`CREATE TABLE IF NOT EXISTS company_profile (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        address TEXT,
        phone TEXT,
        logo_url TEXT,
        theme_color TEXT
    )`).run();

    // 2. جدول الإعدادات العامة
    db.prepare(`CREATE TABLE IF NOT EXISTS system_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tva_rate REAL DEFAULT 19.0,
        document_type TEXT DEFAULT 'FACTURE',
        invoice_lang TEXT DEFAULT 'fr'
    )`).run();

    const row = db.prepare("SELECT COUNT(*) as count FROM system_settings").get();
    if (row && row.count === 0) {
        db.prepare("INSERT INTO system_settings (tva_rate, document_type, invoice_lang) VALUES (19.0, 'FACTURE', 'fr')").run();
    }

    // 3. جدول العملاء
    db.prepare(`CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        phone TEXT,
        address TEXT
    )`).run();

    // 4. جدول مستودع المنتجات
    db.prepare(`CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        price REAL NOT NULL,
        qty INTEGER NOT NULL DEFAULT 0
    )`).run();

    // 5. جدول المبيعات (سجل الفواتير)
    db.prepare(`CREATE TABLE IF NOT EXISTS sales (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        total_amount REAL NOT NULL,
        created_at TEXT NOT NULL
    )`).run();
}

// ================= إدارة أحداث الـ IPC =================

// ميزة الطباعة الحقيقية (تفتح نافذة الطباعة الأصلية لنظام التشغيل)
// نستخدم win.webContents.print() بدل printToPDF لأن printToPDF لا يتعامل بشكل صحيح
// مع تشكيل الحروف العربية (تظهر منفصلة أو معكوسة). نافذة الطباعة الأصلية
// تسمح للمستخدم باختيار طابعة حقيقية أو "Save as PDF" / "Microsoft Print to PDF"
// من نظام التشغيل نفسه، وتعرض النص العربي بشكل سليم.
ipcMain.handle('print-invoice', async (event) => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    if (!win) return { success: false, error: "النافذة غير موجودة" };
    return new Promise((resolve) => {
        win.webContents.print({ silent: false, printBackground: true }, (success, failureReason) => {
            if (success) {
                resolve({ success: true });
            } else if (failureReason === 'cancelled') {
                resolve({ success: false, canceled: true });
            } else {
                resolve({ success: false, error: failureReason });
            }
        });
    });
});

// ميزة الحفظ المباشر كـ PDF (تبقى متاحة كخيار بديل عبر نافذة "حفظ باسم")
ipcMain.handle('save-invoice-pdf', async (event) => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    if (!win) return { success: false, error: "النافذة غير موجودة" };
    try {
        const { canceled, filePath } = await dialog.showSaveDialog(win, {
            title: 'حفظ الفاتورة',
            defaultPath: path.join(app.getPath('documents'), `Invoice_${Date.now()}.pdf`),
            filters: [{ name: 'PDF', extensions: ['pdf'] }]
        });
        if (canceled || !filePath) return { success: false, canceled: true };
        const pdfBuffer = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
        fs.writeFileSync(filePath, pdfBuffer);
        return { success: true, filePath: filePath };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.on('get-total-sales', (event) => {
    // جلب مجموع عمود total_amount من جدول المبيعات
    const row = db.prepare("SELECT SUM(total_amount) as total FROM sales").get();
    const total = row.total || 0;
    event.reply('total-sales-data', total);
});

// بقية الدوال (البروفايل، المنتجات، العملاء)
ipcMain.on('save-setup-data', (event, data) => {
    let finalLogoUrl = '';
    if (data.logoPath && fs.existsSync(data.logoPath)) {
        try {
            const ext = path.extname(data.logoPath);
            const targetDir = path.join(app.getPath('userData'), 'assets');
            if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
            const targetPath = path.join(targetDir, `company-logo${ext}`);
            fs.copyFileSync(data.logoPath, targetPath);
            finalLogoUrl = `file://${targetPath}`;
        } catch (e) { console.error(e); }
    }
    try {
        db.prepare("DELETE FROM company_profile").run();
        db.prepare("INSERT INTO company_profile (name, address, phone, logo_url, theme_color) VALUES (?, ?, ?, ?, ?)")
          .run(data.name, data.address, data.phone, finalLogoUrl, data.themeColor);
        mainWindow.loadFile('index.html');
    } catch (err) { console.error(err); }
});

ipcMain.handle('get-settings', async () => {
    const row = db.prepare("SELECT tva_rate, document_type, invoice_lang FROM system_settings ORDER BY id DESC LIMIT 1").get();
    return row || { tva_rate: 19.0, document_type: 'FACTURE', invoice_lang: 'fr' };
});

ipcMain.handle('save-settings', async (event, settings) => {
    try {
        db.prepare("UPDATE system_settings SET tva_rate = ?, document_type = ?, invoice_lang = ? WHERE id = 1")
          .run(settings.tva_rate, settings.document_type, settings.invoice_lang);
        return { success: true };
    } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.on('get-company-profile', (event) => {
    const row = db.prepare("SELECT name, address, phone, logo_url, theme_color FROM company_profile LIMIT 1").get();
    if (row) event.reply('company-profile-data', row);
});

ipcMain.on('get-customers', (event) => {
    event.reply('customers-data', db.prepare("SELECT id, name, phone, address FROM customers ORDER BY name ASC").all());
});

ipcMain.on('add-customer', (event, customer) => {
    db.prepare("INSERT INTO customers (name, phone, address) VALUES (?, ?, ?)").run(customer.name, customer.phone, customer.address);
    event.reply('customer-added-success');
});

ipcMain.on('delete-customer', (event, id) => {
    db.prepare("DELETE FROM customers WHERE id = ?").run(id);
    event.reply('customer-deleted-success');
});

ipcMain.on('get-products', (event) => {
    event.reply('products-data', db.prepare("SELECT id, name, price, qty FROM products ORDER BY name ASC").all());
});

ipcMain.on('add-product', (event, product) => {
    // التحقق هل المنتج موجود مسبقاً بنفس الاسم
    const existing = db.prepare("SELECT id FROM products WHERE name = ?").get(product.name);
    
    if (existing) {
        // إذا كان موجوداً، قم بتحديث السعر والكمية واحتفظ بنفس الـ ID القديم ثابتاً
        db.prepare("UPDATE products SET price = ?, qty = ? WHERE id = ?")
          .run(product.price, product.qty, existing.id);
    } else {
        // إذا كان منتجاً جديداً تماماً، قم بإضافته
        db.prepare("INSERT INTO products (name, price, qty) VALUES (?, ?, ?)")
          .run(product.name, product.price, product.qty);
    }
    
    event.reply('product-added-success');
});
ipcMain.on('delete-product', (event, id) => {
    db.prepare("DELETE FROM products WHERE id = ?").run(id);
    event.reply('product-deleted-success');
});

ipcMain.on('reduce-products-stock', (event, data) => {
    // استقبال العناصر والمجموع من الواجهة
    const itemsToReduce = data.items;
    const totalAmount = data.total;

    const updateStmt = db.prepare("UPDATE products SET qty = qty - ? WHERE name = ? AND qty >= ?");
    const insertSaleStmt = db.prepare("INSERT INTO sales (total_amount, created_at) VALUES (?, ?)");

    const runUpdates = db.transaction((items, total) => {
        // 1. خصم الكميات
        for (const item of items) {
            const result = updateStmt.run(item.qty, item.name, item.qty);
            if (result.changes === 0) throw new Error('مخزون غير كافٍ');
        }
        
        // 2. تسجيل الفاتورة في جدول المبيعات
        const now = new Date();
        const timestamp = `${now.toLocaleDateString('ar-DZ')} | ${now.toLocaleTimeString('ar-DZ', { hour12: false })}`;
        insertSaleStmt.run(total, timestamp);
        
        return timestamp;
    });

    try {
        const timestamp = runUpdates(itemsToReduce, totalAmount);
        event.reply('stock-reduced-success', timestamp);
    } catch (err) { 
        event.reply('stock-reduced-error', 'تأكد من الكميات!'); 
    }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') { if (db) db.close(); app.quit(); }
});