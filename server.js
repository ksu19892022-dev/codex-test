// 引入必要的模块
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');
const fetch = require('node-fetch');
const cron = require('node-cron');
const storage = require('./storage');

// --- 基础配置 ---
const PORT = 8602;
const BACKUP_DIR = path.join(__dirname, 'backups');
const MAX_BACKUPS = 10;

const storagePaths = storage.getDataPaths();
const LEGACY_JSON_FILE = storagePaths.legacyJson;
const STATE_FILE = storagePaths.stateFile;

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
let memoryState = storage.exportState();
let snapshotTimer = null;

function writeJsonSnapshot() {
    try {
        fs.writeFileSync(LEGACY_JSON_FILE, JSON.stringify(memoryState, null, 2), 'utf8');
    } catch (error) {
        console.error('[Snapshot] 写入 db.json 失败:', error);
    }
}

function scheduleJsonSnapshot() {
    if (snapshotTimer) {
        clearTimeout(snapshotTimer);
    }
    snapshotTimer = setTimeout(() => {
        writeJsonSnapshot();
        snapshotTimer = null;
    }, 1500);
}

function refreshMemoryState() {
    memoryState = storage.exportState();
}

// --- START: 一次性数据迁移脚本 ---
function migrateWorkIdeasToRecords() {
    let migratedCount = 0;
    console.log('[Migration] 正在检查是否需要将 work_idea 迁移到 work_record...');

    memoryState.tasks.forEach((item, index) => {
        if (item.type === 'work_idea') {
            const updated = { ...item, type: 'work_record' };
            if (Array.isArray(updated.tags)) {
                const tagIndex = updated.tags.indexOf('工作想法');
                if (tagIndex > -1) {
                    updated.tags[tagIndex] = '工作记录';
                }
            }
            const normalized = storage.persistTask(updated);
            if (normalized) {
                memoryState.tasks[index] = normalized;
                migratedCount++;
            }
        }
    });

    if (migratedCount > 0) {
        console.log(`[Migration] 成功迁移了 ${migratedCount} 条“工作想法”到“工作记录”。`);
        scheduleJsonSnapshot();
    } else {
        console.log('[Migration] 无需迁移，数据已是最新格式。');
    }
}
migrateWorkIdeasToRecords();
// --- END: 一次性数据迁移脚本 ---

writeJsonSnapshot();

// --- 备份与清理功能 ---
function createBackup() {
    try {
        if (!fs.existsSync(STATE_FILE)) return;
        if (!fs.existsSync(BACKUP_DIR)) {
            fs.mkdirSync(BACKUP_DIR, { recursive: true });
        }
        const now = new Date();
        const timestamp = now.toISOString().replace(/[:.]/g, '-');
        const stateBackupName = `backup-${timestamp}.state.json`;
        const stateBackupPath = path.join(BACKUP_DIR, stateBackupName);
        fs.copyFileSync(STATE_FILE, stateBackupPath);

        const exportBackupName = `backup-${timestamp}.export.json`;
        const exportBackupPath = path.join(BACKUP_DIR, exportBackupName);
        fs.writeFileSync(exportBackupPath, JSON.stringify(memoryState, null, 2), 'utf8');

        console.log(`[Backup] 已生成备份: ${stateBackupName} & ${exportBackupName}`);

        const stateBackups = fs.readdirSync(BACKUP_DIR)
            .filter(file => file.startsWith('backup-') && file.endsWith('.state.json'))
            .sort()
            .reverse();
        if (stateBackups.length > MAX_BACKUPS) {
            const filesToDelete = stateBackups.slice(MAX_BACKUPS);
            filesToDelete.forEach(file => {
                fs.unlinkSync(path.join(BACKUP_DIR, file));
                const jsonFile = file.replace(/\.state\.json$/, '.export.json');
                const jsonPath = path.join(BACKUP_DIR, jsonFile);
                if (fs.existsSync(jsonPath)) {
                    fs.unlinkSync(jsonPath);
                }
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
        if (action === 'replaceAll') {
            let tasksToImport = [];
            let notebooksToImport = memoryState.notebooks;
            if (Array.isArray(data)) {
                tasksToImport = data;
            } else if (data && typeof data === 'object') {
                tasksToImport = Array.isArray(data.tasks) ? data.tasks : [];
                if (Array.isArray(data.notebooks)) {
                    notebooksToImport = data.notebooks;
                }
            }
            storage.replaceAll({ tasks: tasksToImport, notebooks: notebooksToImport });
            refreshMemoryState();
            updateSuccessful = true;
            console.log('[Atomic Op] 数据库已通过导入操作完全替换。');
        }
    } else if (entity === 'notebook') {
        if (action === 'updateAll' && Array.isArray(data)) {
            storage.replaceNotebooks(data);
            memoryState.notebooks = storage.getAllNotebooks();
            updateSuccessful = true;
            console.log('[Atomic Op] 笔记本列表已完全更新。');
        }
    } else if (entity === 'task') {
        switch (action) {
            case 'create': {
                if (data && typeof data === 'object' && data.id !== undefined && data.id !== null) {
                    const taskId = String(data.id);
                    if (!memoryState.tasks.some(item => String(item.id) === taskId)) {
                        const normalized = storage.persistTask({ ...data });
                        if (normalized) {
                            memoryState.tasks.unshift(normalized);
                            updateSuccessful = true;
                        }
                    } else {
                        console.warn(`[Atomic Op] 创建失败: ID 为 ${taskId} 的项目已存在。`);
                    }
                }
                break;
            }
            case 'update': {
                if (data && data.id !== undefined && data.id !== null) {
                    const taskId = String(data.id);
                    const itemIndex = memoryState.tasks.findIndex(item => String(item.id) === taskId);
                    if (itemIndex > -1) {
                        const updatedTask = { ...memoryState.tasks[itemIndex], ...data };
                        const normalized = storage.persistTask(updatedTask);
                        if (normalized) {
                            memoryState.tasks[itemIndex] = normalized;
                            updateSuccessful = true;
                        }
                    } else {
                        console.warn(`[Atomic Op] 更新失败: 未找到 ID 为 ${taskId} 的项目。`);
                    }
                }
                break;
            }
            case 'delete': {
                if (data && data.id !== undefined && data.id !== null) {
                    const taskId = String(data.id);
                    const itemIndex = memoryState.tasks.findIndex(item => String(item.id) === taskId);
                    if (itemIndex > -1) {
                        storage.deleteTask(taskId);
                        memoryState.tasks.splice(itemIndex, 1);
                        updateSuccessful = true;
                    } else {
                        console.warn(`[Atomic Op] 删除失败: 未找到 ID 为 ${taskId} 的项目。`);
                    }
                }
                break;
            }
            case 'updateNested': {
                if (data && data.parentId !== undefined && data.parentId !== null) {
                    const taskId = String(data.parentId);
                    const parentIndex = memoryState.tasks.findIndex(item => String(item.id) === taskId);
                    if (parentIndex > -1) {
                        const parentItem = {
                            ...memoryState.tasks[parentIndex],
                            savedInsights: Array.isArray(memoryState.tasks[parentIndex].savedInsights)
                                ? [...memoryState.tasks[parentIndex].savedInsights]
                                : []
                        };
                        if (data.action === 'addInsight' && data.insight) {
                            parentItem.savedInsights.push(data.insight);
                            const normalized = storage.persistTask(parentItem);
                            if (normalized) {
                                memoryState.tasks[parentIndex] = normalized;
                                updateSuccessful = true;
                            }
                        } else if (data.action === 'deleteInsight' && data.insightId !== undefined) {
                            const initialLength = parentItem.savedInsights.length;
                            parentItem.savedInsights = parentItem.savedInsights.filter(i => i.id !== data.insightId);
                            if (parentItem.savedInsights.length < initialLength) {
                                const normalized = storage.persistTask(parentItem);
                                if (normalized) {
                                    memoryState.tasks[parentIndex] = normalized;
                                    updateSuccessful = true;
                                }
                            }
                        }
                    }
                }
                break;
            }
            default:
                console.warn(`[Atomic Op] 收到未知的原子操作: ${action}`);
                return;
        }
    } else {
        console.warn(`[Atomic Op] 收到未知的实体类型: ${entity}`);
    }

    if (updateSuccessful) {
        scheduleJsonSnapshot();
        wss.broadcast({
            type: 'dbUpdated',
            payload: memoryState,
        });
        console.log(`[WS] 数据已更新并广播给所有 ${wss.clients.size} 个客户端。`);
    }
}


wss.on('connection', function connection(ws) {
    console.log(`一个新的客户端已连接。当前在线: ${wss.clients.size} 人。`);

    // [核心修改] 发送包含 tasks 和 notebooks 的完整状态
    ws.send(JSON.stringify({ type: 'initialState', payload: memoryState }));

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

// [核心修改] API 端点现在返回数据库中的任务快照
app.get('/api/tasks', (req, res) => {
    res.json(memoryState.tasks || []);
});

app.get('/api/state', (req, res) => {
    res.json(memoryState);
});

app.get('/api/search/tasks', (req, res) => {
    try {
        const { q = '', type, includeCompleted, scheduledOnly, todoOnly, notebook, limit } = req.query;
        const parsedLimit = Math.max(1, Math.min(parseInt(limit, 10) || 50, 200));
        const results = storage.searchTasks({
            query: q,
            type: type || undefined,
            includeCompleted: includeCompleted === undefined ? true : includeCompleted !== 'false',
            scheduledOnly: scheduledOnly === 'true',
            todoOnly: todoOnly === 'true',
            notebook: notebook || undefined,
            limit: parsedLimit
        });
        res.json(results.map(({ task, score }) => ({ task, score, id: task.id })));
    } catch (error) {
        console.error('[Search] 查询失败:', error);
        res.status(500).json({ error: '搜索失败，请稍后再试。' });
    }
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