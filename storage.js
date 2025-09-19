const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'state.json');
const OPERATIONS_FILE = path.join(DATA_DIR, 'operations.log');
const LEGACY_JSON_FILE = path.join(__dirname, 'db.json');

const DEFAULT_NOTEBOOKS = [
  '工厂管理',
  '陶瓷工艺',
  '文旅笔记',
  '业务管理',
  '团队协作',
  '客户沟通',
  '财务流程',
  '其他'
];

const FLUSH_INTERVAL = 5000;
const FLUSH_THRESHOLD = 20;

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function structuredCloneFallback(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function normalizeTask(task) {
  const normalized = structuredCloneFallback(task);
  normalized.id = normalized.id ?? Date.now();
  normalized.createdAt = normalized.createdAt || new Date().toISOString();
  normalized.tags = Array.isArray(normalized.tags) ? normalized.tags : (normalized.tags ? [normalized.tags] : []);
  normalized.savedInsights = Array.isArray(normalized.savedInsights) ? normalized.savedInsights : [];
  normalized.notebooks = Array.isArray(normalized.notebooks) ? normalized.notebooks : [];
  return normalized;
}

function sanitizeNotebooks(notebooks) {
  if (!Array.isArray(notebooks) || notebooks.length === 0) {
    return [...DEFAULT_NOTEBOOKS];
  }
  const unique = Array.from(new Set(notebooks.filter(Boolean)));
  return unique.length > 0 ? unique : [...DEFAULT_NOTEBOOKS];
}

class Storage {
  constructor() {
    ensureDir(DATA_DIR);
    this.state = {
      tasks: [],
      notebooks: [...DEFAULT_NOTEBOOKS]
    };
    this.taskIndex = new Map();
    this.pendingOps = 0;
    this.flushTimer = null;

    this.loadSnapshot();
    this.replayOperations();
    this.flushState(true);

    process.on('exit', () => {
      if (this.pendingOps > 0) {
        try { this.flushState(true); } catch (error) { console.error('[Storage] 退出前写入失败:', error); }
      }
    });

    process.on('SIGINT', () => {
      try { this.flushState(true); } catch (error) { console.error('[Storage] SIGINT 写入失败:', error); }
      process.exit();
    });
  }

  loadSnapshot() {
    try {
      if (fs.existsSync(SNAPSHOT_FILE)) {
        const raw = fs.readFileSync(SNAPSHOT_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          this.state.tasks = Array.isArray(parsed.tasks) ? parsed.tasks.map(normalizeTask) : [];
          this.state.notebooks = sanitizeNotebooks(parsed.notebooks);
          this.rebuildTaskIndex();
          return;
        }
      }
      this.loadLegacyJson();
    } catch (error) {
      console.error('[Storage] 读取快照失败:', error);
      this.loadLegacyJson();
    }
  }

  loadLegacyJson() {
    try {
      if (!fs.existsSync(LEGACY_JSON_FILE)) {
        this.state = { tasks: [], notebooks: [...DEFAULT_NOTEBOOKS] };
        this.rebuildTaskIndex();
        return;
      }
      const raw = fs.readFileSync(LEGACY_JSON_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.state.tasks = parsed.map(normalizeTask);
        this.state.notebooks = [...DEFAULT_NOTEBOOKS];
      } else if (parsed && typeof parsed === 'object') {
        this.state.tasks = Array.isArray(parsed.tasks) ? parsed.tasks.map(normalizeTask) : [];
        this.state.notebooks = sanitizeNotebooks(parsed.notebooks);
      }
      this.rebuildTaskIndex();
    } catch (error) {
      console.error('[Storage] 无法读取 legacy db.json:', error);
      this.state = { tasks: [], notebooks: [...DEFAULT_NOTEBOOKS] };
      this.rebuildTaskIndex();
    }
  }

  replayOperations() {
    try {
      if (!fs.existsSync(OPERATIONS_FILE)) {
        fs.writeFileSync(OPERATIONS_FILE, '', 'utf8');
        return;
      }
      const logContent = fs.readFileSync(OPERATIONS_FILE, 'utf8');
      if (!logContent) return;
      const lines = logContent.split('\n').filter(Boolean);
      lines.forEach(line => {
        try {
          const entry = JSON.parse(line);
          this.applyOperation(entry, { skipLog: true, skipFlush: true });
        } catch (error) {
          console.error('[Storage] 无法解析操作日志行:', line, error);
        }
      });
      this.pendingOps = 0;
      fs.writeFileSync(OPERATIONS_FILE, '', 'utf8');
    } catch (error) {
      console.error('[Storage] 回放操作日志失败:', error);
    }
  }

  rebuildTaskIndex() {
    this.taskIndex.clear();
    this.state.tasks.forEach((task, index) => {
      this.taskIndex.set(String(task.id), index);
    });
  }

  appendOperation(type, payload) {
    try {
      const entry = JSON.stringify({ type, payload, at: Date.now() });
      fs.appendFileSync(OPERATIONS_FILE, entry + '\n');
      this.pendingOps += 1;
    } catch (error) {
      console.error('[Storage] 写入操作日志失败:', error);
    }
  }

  scheduleFlush(force = false) {
    if (force) {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      this.flushState();
      return;
    }

    if (this.pendingOps >= FLUSH_THRESHOLD) {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      this.flushState();
      return;
    }

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flushState();
      }, FLUSH_INTERVAL);
    }
  }

  flushState(initial = false) {
    try {
      const payload = JSON.stringify(this.state, null, 2);
      const tempPath = SNAPSHOT_FILE + '.tmp';
      fs.writeFileSync(tempPath, payload, 'utf8');
      fs.renameSync(tempPath, SNAPSHOT_FILE);
      if (!initial) {
        fs.writeFileSync(OPERATIONS_FILE, '', 'utf8');
        this.pendingOps = 0;
      }
    } catch (error) {
      console.error('[Storage] 写入快照失败:', error);
    }
  }

  applyOperation(entry, { skipLog = false, skipFlush = false } = {}) {
    switch (entry.type) {
      case 'task:upsert':
        return this.applyTaskUpsert(entry.payload, { skipLog, skipFlush });
      case 'task:delete':
        return this.applyTaskDelete(entry.payload?.id, { skipLog, skipFlush });
      case 'notebook:updateAll':
        return this.updateNotebooks(entry.payload?.notebooks, { skipLog, skipFlush });
      default:
        return null;
    }
  }

  applyTaskUpsert(task, { skipLog = false, skipFlush = false } = {}) {
    const normalized = normalizeTask(task);
    const key = String(normalized.id);
    const existingIndex = this.taskIndex.get(key);
    if (existingIndex !== undefined) {
      this.state.tasks[existingIndex] = normalized;
    } else {
      this.state.tasks.unshift(normalized);
      this.rebuildTaskIndex();
    }

    if (!skipLog) {
      this.appendOperation('task:upsert', normalized);
      this.scheduleFlush();
    } else if (!skipFlush) {
      this.scheduleFlush();
    }

    return structuredCloneFallback(normalized);
  }

  applyTaskDelete(id, { skipLog = false, skipFlush = false } = {}) {
    if (id === undefined || id === null) return false;
    const key = String(id);
    const index = this.taskIndex.get(key);
    if (index === undefined) return false;
    this.state.tasks.splice(index, 1);
    this.rebuildTaskIndex();

    if (!skipLog) {
      this.appendOperation('task:delete', { id });
      this.scheduleFlush();
    } else if (!skipFlush) {
      this.scheduleFlush();
    }
    return true;
  }

  updateNotebooks(notebooks, { skipLog = false, skipFlush = false } = {}) {
    this.state.notebooks = sanitizeNotebooks(notebooks);
    if (!skipLog) {
      this.appendOperation('notebook:updateAll', { notebooks: this.state.notebooks });
      this.scheduleFlush();
    } else if (!skipFlush) {
      this.scheduleFlush();
    }
    return [...this.state.notebooks];
  }

  persistTask(task) {
    return this.applyTaskUpsert(task, { skipLog: false, skipFlush: false });
  }

  deleteTask(id) {
    const deleted = this.applyTaskDelete(id, { skipLog: false, skipFlush: false });
    return deleted;
  }

  getTaskById(id) {
    const key = String(id);
    const index = this.taskIndex.get(key);
    if (index === undefined) return null;
    return structuredCloneFallback(this.state.tasks[index]);
  }

  getAllTasks() {
    return this.state.tasks.map(task => structuredCloneFallback(task));
  }

  getAllNotebooks() {
    return [...this.state.notebooks];
  }

  replaceAll({ tasks, notebooks }) {
    const safeTasks = Array.isArray(tasks) ? tasks.map(normalizeTask) : [];
    const safeNotebooks = sanitizeNotebooks(notebooks);
    this.state.tasks = safeTasks;
    this.state.notebooks = safeNotebooks;
    this.rebuildTaskIndex();
    this.pendingOps = 0;
    this.flushState();
  }

  replaceNotebooks(notebooks) {
    this.updateNotebooks(notebooks, { skipLog: false, skipFlush: false });
  }

  searchTasks(options) {
    const {
      query,
      limit = 50,
      type,
      includeCompleted = true,
      scheduledOnly = false,
      todoOnly = false,
      notebook
    } = options || {};

    const trimmed = (query || '').trim();
    if (!trimmed) return [];

    const tokens = Array.from(new Set(trimmed.toLowerCase().split(/\s+/).filter(Boolean)));
    if (tokens.length === 0) {
      tokens.push(trimmed.toLowerCase());
    }

    const now = Date.now();
    const matches = [];

    for (const task of this.state.tasks) {
      if (type && task.type !== type) continue;
      if (!includeCompleted && task.isCompleted) continue;
      if (scheduledOnly && !task.startDate) continue;
      if (todoOnly && task.startDate) continue;
      if (notebook && (!Array.isArray(task.notebooks) || !task.notebooks.includes(notebook))) continue;

      const haystack = [task.title, task.rawText, ...(task.tags || []), ...(task.notebooks || [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      let score = 0;
      for (const token of tokens) {
        if (haystack.includes(token)) {
          score += 1;
        }
      }

      if (score === 0) continue;

      // Boost by recency (within ~30 days)
      const createdAt = task.createdAt ? new Date(task.createdAt).getTime() : 0;
      const daysDiff = createdAt ? (now - createdAt) / (1000 * 60 * 60 * 24) : 999;
      const recencyBoost = daysDiff < 1 ? 3 : daysDiff < 7 ? 2 : daysDiff < 30 ? 1 : 0;
      const completionBoost = task.isCompleted ? 0 : 1;

      matches.push({
        task: structuredCloneFallback(task),
        score: score * 2 + recencyBoost + completionBoost,
        createdAt
      });
    }

    matches.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.createdAt || 0) - (a.createdAt || 0);
    });

    return matches.slice(0, limit).map(({ task, score }) => ({ task, score }));
  }

  exportState() {
    return {
      tasks: this.getAllTasks(),
      notebooks: this.getAllNotebooks()
    };
  }

  getDataPaths() {
    return {
      directory: DATA_DIR,
      stateFile: SNAPSHOT_FILE,
      legacyJson: LEGACY_JSON_FILE
    };
  }
}

module.exports = new Storage();
