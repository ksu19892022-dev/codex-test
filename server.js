// 引入必要的模块
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');
const fetch = require('node-fetch');
const cron = require('node-cron');

// --- 基础配置 ---
const PORT = 8602;
const DB_FILE = path.join(__dirname, 'db.json');
const BACKUP_DIR = path.join(__dirname, 'backups');
const MAX_BACKUPS = 10;

// [安全更新] 从环境变量或直接从代码中获取 AI API Key
const ARK_API_KEY = "5cc4ad2f-86f1-4948-bad6-ab9646d1fda9";
const API_URL = "https://ark.cn-beijing.volces.com/api/v3/chat/completions";
const MODEL_ID = "deepseek-v3-1-250821";

// 创建 Express 应用
const app = express();
// 创建 HTTP 服务器
const server = http.createServer(app);
// 创建 WebSocket 服务器
const wss = new WebSocket.Server({ server });

// --- 数据处理 ---
// [核心修改] db 现在是一个包含 tasks 和 notebooks 的对象
let db = {};

// 保存数据到 JSON 文件
function saveDB() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
        console.log('[OK] 数据已成功写入 db.json');
    } catch (error) {
        console.error('写入数据到 db.json 失败:', error);
    }
}

// [核心修改] 从 JSON 文件加载数据，并处理数据迁移
function loadDB() {
    try {
        // 默认的笔记本分类
        const defaultNotebooks = ['工厂管理', '陶瓷工艺', '文旅笔记', '业务管理', '团队协作', '客户沟通', '财务流程', '其他'];

        if (fs.existsSync(DB_FILE)) {
            const data = fs.readFileSync(DB_FILE, 'utf8');
            const jsonData = JSON.parse(data);
            
            // 检查是旧的数组格式还是新的对象格式
            if (Array.isArray(jsonData)) {
                console.log('[Migration] 检测到旧的数组格式数据，正在迁移...');
                db = {
                    tasks: jsonData,
                    notebooks: defaultNotebooks
                };
                saveDB(); // 迁移后立即保存为新格式
            } else {
                db = jsonData;
                // 确保 notebooks 字段存在，如果不存在则添加
                if (!db.notebooks || !Array.isArray(db.notebooks)) {
                    console.log('[Migration] 数据中缺少笔记本列表，正在添加默认列表...');
                    db.notebooks = defaultNotebooks;
                    saveDB();
                }
            }
            console.log('成功从 db.json 加载了数据。');
        } else {
            console.log('未找到 db.json，将使用空数据结构启动。');
            db = { tasks: [], notebooks: defaultNotebooks };
        }
    } catch (error) {
        console.error('读取 db.json 文件失败:', error);
        db = { tasks: [], notebooks: [] }; // 如果文件损坏，则使用空结构启动
    }
}


// 启动时加载数据
loadDB();

// --- START: 一次性数据迁移脚本 ---
function migrateWorkIdeasToRecords() {
    let migratedCount = 0;
    console.log('[Migration] 正在检查是否需要将 work_idea 迁移到 work_record...');

    // [核心修改] 遍历 db.tasks 而不是 db
    db.tasks.forEach(item => {
        if (item.type === 'work_idea') {
            item.type = 'work_record';
            if (item.tags && Array.isArray(item.tags)) {
                const tagIndex = item.tags.indexOf('工作想法');
                if (tagIndex > -1) {
                    item.tags[tagIndex] = '工作记录';
                }
            }
            migratedCount++;
        }
    });

    if (migratedCount > 0) {
        console.log(`[Migration] 成功迁移了 ${migratedCount} 条“工作想法”到“工作记录”。`);
        saveDB();
    } else {
        console.log('[Migration] 无需迁移，数据已是最新格式。');
    }
}
migrateWorkIdeasToRecords();
// --- END: 一次性数据迁移脚本 ---

// --- 备份与清理功能 ---
function createBackup() {
    try {
        if (!fs.existsSync(DB_FILE)) return;
        if (!fs.existsSync(BACKUP_DIR)) {
            fs.mkdirSync(BACKUP_DIR, { recursive: true });
        }
        const now = new Date();
        const timestamp = now.toISOString().replace(/[:.]/g, '-');
        const backupFileName = `backup-${timestamp}.json`;
        const backupFilePath = path.join(BACKUP_DIR, backupFileName);
        fs.copyFileSync(DB_FILE, backupFilePath);
        console.log(`[Backup] 成功创建备份文件: ${backupFileName}`);
        const backupFiles = fs.readdirSync(BACKUP_DIR)
            .filter(file => file.startsWith('backup-') && file.endsWith('.json'))
            .sort()
            .reverse();
        if (backupFiles.length > MAX_BACKUPS) {
            const filesToDelete = backupFiles.slice(MAX_BACKUPS);
            filesToDelete.forEach(file => {
                fs.unlinkSync(path.join(BACKUP_DIR, file));
                console.log(`[Backup] 已删除旧备份文件: ${file}`);
            });
        }
    } catch (error) {
        console.error('[Backup] 备份或清理过程失败:', error);
    }
}

// --- WebSocket 实时通信 ---
wss.broadcast = function broadcast(data) {
    const message = JSON.stringify(data);
    wss.clients.forEach(function each(client) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message, (err) => {
                if (err) console.error('发送消息失败:', err);
            });
        }
    });
};

/**
 * [核心重构] 处理原子化更新指令
 * @param {object} payload - 包含操作信息的对象
 */
function handleAtomicUpdate(payload) {
    const { entity = 'task', action, data, userId, logAction } = payload;
    let updateSuccessful = false;

    console.log(`[Atomic Op] 收到指令: ${logAction || `${entity}.${action}`} by ${userId || 'Unknown'}`);
    
    if (entity === 'db') {
        switch (action) {
            case 'replaceAll':
                if (data && data.tasks && Array.isArray(data.tasks)) {
                    // [核心修改] 确保导入的数据也是新格式
                    db.tasks = data.tasks;
                    db.notebooks = data.notebooks || db.notebooks; // 保留笔记本或使用导入的
                    updateSuccessful = true;
                    console.log('[Atomic Op] 数据库已通过导入操作完全替换。');
                }
                break;
        }
    }
    // [新增] 处理 notebook 实体的更新
    else if (entity === 'notebook') {
        switch (action) {
            case 'updateAll':
                if (Array.isArray(data)) {
                    db.notebooks = data;
                    updateSuccessful = true;
                    console.log('[Atomic Op] 笔记本列表已完全更新。');
                }
                break;
        }
    } 
    else if (entity === 'task') {
        // [核心修改] 所有操作都针对 db.tasks
        switch (action) {
            case 'create':
                if(data && typeof data === 'object' && data.id){
                    if (!db.tasks.some(item => item.id === data.id)) {
                        db.tasks.unshift(data);
                        updateSuccessful = true;
                    } else {
                        console.warn(`[Atomic Op] 创建失败: ID 为 ${data.id} 的项目已存在。`);
                    }
                }
                break;

            case 'update':
                const itemIndex = db.tasks.findIndex(item => item.id === data.id);
                if (itemIndex > -1) {
                    db.tasks[itemIndex] = { ...db.tasks[itemIndex], ...data };
                    updateSuccessful = true;
                } else {
                    console.warn(`[Atomic Op] 更新失败: 未找到 ID 为 ${data.id} 的项目。`);
                }
                break;

            case 'delete':
                const initialLength = db.tasks.length;
                db.tasks = db.tasks.filter(item => item.id !== data.id);
                if (db.tasks.length < initialLength) {
                    updateSuccessful = true;
                } else {
                    console.warn(`[Atomic Op] 删除失败: 未找到 ID 为 ${data.id} 的项目。`);
                }
                break;
            
            case 'updateNested':
                const parentIndex = db.tasks.findIndex(item => item.id === data.parentId);
                if (parentIndex > -1) {
                    const parentItem = db.tasks[parentIndex];
                    if (!parentItem.savedInsights) {
                        parentItem.savedInsights = [];
                    }
                    if (data.action === 'addInsight') {
                        parentItem.savedInsights.push(data.insight);
                        updateSuccessful = true;
                    } else if (data.action === 'deleteInsight') {
                        const insightsInitialLength = parentItem.savedInsights.length;
                        parentItem.savedInsights = parentItem.savedInsights.filter(i => i.id !== data.insightId);
                        if (parentItem.savedInsights.length < insightsInitialLength) {
                            updateSuccessful = true;
                        }
                    }
                }
                break;
                
            default:
                console.warn(`[Atomic Op] 收到未知的原子操作: ${action}`);
                return;
        }
    } else {
        console.warn(`[Atomic Op] 收到未知的实体类型: ${entity}`);
    }

    if (updateSuccessful) {
        saveDB();
        // [核心修改] 广播整个 db 对象
        wss.broadcast({
            type: 'dbUpdated',
            payload: db,
        });
        console.log(`[WS] 数据已更新并广播给所有 ${wss.clients.size} 个客户端。`);
    }
}


wss.on('connection', function connection(ws) {
    console.log(`一个新的客户端已连接。当前在线: ${wss.clients.size} 人。`);
    
    // [核心修改] 发送包含 tasks 和 notebooks 的完整状态
    ws.send(JSON.stringify({ type: 'initialState', payload: db }));

    ws.on('message', function incoming(rawMessage) {
        try {
            const message = JSON.parse(rawMessage);
            
            switch (message.type) {
                case 'atomicUpdate':
                    handleAtomicUpdate(message.payload);
                    break;
                case 'ping':
                    ws.send(JSON.stringify({ type: 'pong' }));
                    break;
                default:
                    console.warn('收到未知类型的消息:', message.type);
            }
        } catch (error) {
            console.error('处理接收到的消息失败:', error);
        }
    });

    ws.on('close', () => console.log(`一个客户端已断开连接。剩余在线: ${wss.clients.size} 人。`));
    ws.on('error', (error) => console.error('WebSocket 发生错误:', error));
});

// --- HTTP 服务 ---
app.use(express.static(path.join(__dirname)));
app.use(express.json());

// [核心修改] API 端点现在返回 db.tasks
app.get('/api/tasks', (req, res) => {
    res.json(db.tasks || []);
});

// AI 代理接口 (无修改)
app.post('/api/ark-proxy', async (req, res) => {
    if (!ARK_API_KEY || ARK_API_KEY === "YOUR_ARK_API_KEY") {
        return res.status(500).json({ error: '服务器未配置有效的 ARK_API_KEY。' });
    }
    try {
        const { prompt, stream, messages } = req.body;
        const payload = {
            model: MODEL_ID,
            messages: messages || [{ role: "user", content: prompt }],
            stream: stream || false
        };
        const apiResponse = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${ARK_API_KEY}`
            },
            body: JSON.stringify(payload)
        });
        if (!apiResponse.ok) {
            const errorBody = await apiResponse.json();
            throw new Error(`API 请求失败 (状态码: ${apiResponse.status}): ${errorBody.error.message}`);
        }
        if (stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            apiResponse.body.pipe(res);
        } else {
            const result = await apiResponse.json();
            res.json(result);
        }
    } catch (error) {
        console.error('AI 代理请求失败:', error);
        res.status(500).json({ error: error.message });
    }
});


app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- 启动定时备份任务 ---
cron.schedule('0 4 * * *', () => {
    console.log('[Cron] 正在执行每日凌晨4点的定时备份任务...');
    createBackup();
}, {
    scheduled: true,
    timezone: "Asia/Shanghai"
});

// --- 启动服务器并显示 IP 地址 ---
server.listen(PORT, () => {
    console.log(`\n服务器已成功启动！`);
    console.log('--------------------------------------');
    
    const interfaces = os.networkInterfaces();
    let lanAddress = null;
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if ('IPv4' !== iface.family || iface.internal !== false) continue;
            lanAddress = iface.address;
        }
    }
    
    console.log(`💻 在本机浏览器中访问: http://localhost:${PORT}`);
    if (lanAddress) {
        console.log(`🌐 在局域网内其他设备上访问: http://${lanAddress}:${PORT}`);
    } else {
        console.log('🔌 未能检测到局域网IP地址，请确保电脑已连接到网络。');
    }
    console.log('--------------------------------------');
    console.log(`[Cron] 每日数据备份任务已设定在凌晨 4:00。`);
});