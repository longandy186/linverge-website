/**
 * Feishu (Lark) Bitable API Middleware
 * Linverge Dashboard - 布草管理系统飞书多维表格接口层
 *
 * 本模块为纯前端静态网站设计，通过 fetch 直接调用飞书开放平台 API。
 * 支持 CORS 代理配置、Token 自动管理、离线缓存及事件通知机制。
 *
 * @module feishu-api
 * @version 1.0.0
 * @author Linverge Team
 * @license MIT
 */

/* global sessionStorage, localStorage, fetch, Blob, URL, navigator */

// ============================================================
// 1. Configuration
// ============================================================

/**
 * 飞书 API 全局配置对象。
 * 在仪表盘设置页面中通过 `FeishuAPI.configure()` 进行赋值。
 *
 * @typedef {Object} FeishuConfig
 * @property {string} APP_ID       - 飞书应用 App ID
 * @property {string} APP_SECRET   - 飞书应用 App Secret
 * @property {string} BASE_TOKEN   - 多维表格 App Token
 * @property {Object} TABLES       - 各业务数据表 ID 映射
 * @property {string} TABLES.assets       - 布草资产表 ID
 * @property {string} TABLES.transactions - 收发记录表 ID
 * @property {string} TABLES.wash         - 洗涤记录表 ID
 * @property {string} TABLES.hotels       - 酒店客户表 ID
 * @property {string} TABLES.inventory    - 库存盘点表 ID
 * @property {string} CORS_PROXY   - 可选 CORS 代理 URL 前缀
 */
const FEISHU_CONFIG = {
    /** @type {string} 飞书应用 App ID */
    APP_ID: '',
    /** @type {string} 飞书应用 App Secret */
    APP_SECRET: '',
    /** @type {string} 多维表格 App Token */
    BASE_TOKEN: '',
    /** @type {Object} 各业务数据表 ID */
    TABLES: {
        /** @type {string} 布草资产表 ID */
        assets: '',
        /** @type {string} 收发记录表 ID */
        transactions: '',
        /** @type {string} 洗涤记录表 ID */
        wash: '',
        /** @type {string} 酒店客户表 ID */
        hotels: '',
        /** @type {string} 库存盘点表 ID */
        inventory: ''
    },
    /** @type {string} 可选 CORS 代理 URL 前缀（如 'https://cors-proxy.example.com/'） */
    CORS_PROXY: ''
};

// ============================================================
// 2. Internal State
// ============================================================

/** @type {{ token: string, expiresAt: number }|null} 内存中的 Token 缓存 */
let _tokenCache = null;

/** @type {boolean} 当前是否处于离线模式 */
let _isOffline = false;

/** @type {Object.<string, Function[]>} 事件监听器注册表 */
const _eventListeners = {
    dataLoaded: [],
    error: [],
    offline: []
};

/** @type {string} sessionStorage 中存储 Token 的 key */
const TOKEN_STORAGE_KEY = 'feishu_tenant_token';

/** @type {string} localStorage 中离线数据前缀 */
const OFFLINE_PREFIX = 'feishu_offline_';

/** @type {string} localStorage 中待同步队列前缀 */
const PENDING_PREFIX = 'feishu_pending_';

/** @type {string} 飞书开放平台 API 基础地址 */
const API_BASE = 'https://open.feishu.cn/open-apis';

/** @type {number} Token 默认缓存时间（秒），飞书 tenant_access_token 有效期 2 小时 */
const TOKEN_TTL = 7200;

/** @type {number} 默认分页大小 */
const DEFAULT_PAGE_SIZE = 100;

// ============================================================
// 3. Utility Helpers (Private)
// ============================================================

/**
 * 构建带 CORS 代理前缀的完整 URL。
 * @param {string} path - API 路径（不含域名）
 * @returns {string} 完整可请求的 URL
 * @private
 */
function _buildUrl(path) {
    const base = API_BASE + path;
    if (FEISHU_CONFIG.CORS_PROXY) {
        const proxy = FEISHU_CONFIG.CORS_PROXY.replace(/\/+$/, '');
        return proxy + '/' + base;
    }
    return base;
}

/**
 * 触发指定事件的所有监听回调。
 * @param {string} event - 事件名称
 * @param {*} data - 传递给回调的数据
 * @private
 */
function _emit(event, data) {
    const listeners = _eventListeners[event];
    if (!listeners || listeners.length === 0) return;
    try {
        listeners.forEach(function (cb) {
            cb(data);
        });
    } catch (err) {
        console.error('[FeishuAPI] 事件回调执行出错:', event, err);
    }
}

/**
 * 将错误信息规范化为统一格式。
 * @param {Error|string|Object} err - 原始错误
 * @returns {{ code: number, message: string, raw: * }} 规范化后的错误对象
 * @private
 */
function _normalizeError(err) {
    if (err && typeof err === 'object' && err.code !== undefined) {
        return {
            code: err.code,
            message: err.msg || err.message || '未知错误',
            raw: err
        };
    }
    return {
        code: -1,
        message: (err && err.message) ? err.message : String(err),
        raw: err
    };
}

/**
 * 检查当前网络是否可用。
 * @returns {boolean}
 * @private
 */
function _isOnline() {
    if (typeof navigator !== 'undefined' && navigator.onLine !== undefined) {
        return navigator.onLine;
    }
    return true;
}

/**
 * 安全地读取 sessionStorage。
 * @param {string} key
 * @returns {string|null}
 * @private
 */
function _sessionGet(key) {
    try {
        return sessionStorage.getItem(key);
    } catch (_) {
        return null;
    }
}

/**
 * 安全地写入 sessionStorage。
 * @param {string} key
 * @param {string} value
 * @private
 */
function _sessionSet(key, value) {
    try {
        sessionStorage.setItem(key, value);
    } catch (_) {
        // sessionStorage 不可用时静默失败
    }
}

/**
 * 安全地读取 localStorage。
 * @param {string} key
 * @returns {string|null}
 * @private
 */
function _localGet(key) {
    try {
        return localStorage.getItem(key);
    } catch (_) {
        return null;
    }
}

/**
 * 安全地写入 localStorage。
 * @param {string} key
 * @param {string} value
 * @private
 */
function _localSet(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch (_) {
        // localStorage 不可用时静默失败
    }
}

/**
 * 安全地从 localStorage 删除指定 key。
 * @param {string} key
 * @private
 */
function _localRemove(key) {
    try {
        localStorage.removeItem(key);
    } catch (_) {
        // 静默失败
    }
}

// ============================================================
// 4. Token Management
// ============================================================

/**
 * 获取飞书 tenant_access_token。
 *
 * 优先从内存缓存读取；缓存过期则重新请求飞书接口。
 * 获取成功后同时写入 sessionStorage 以便同会话复用。
 *
 * @async
 * @returns {Promise<string>} tenant_access_token
 * @throws {Error} 当 APP_ID / APP_SECRET 未配置或请求失败时抛出
 */
async function getTenantToken() {
    // 1) 内存缓存有效
    if (_tokenCache && _tokenCache.token && Date.now() < _tokenCache.expiresAt) {
        return _tokenCache.token;
    }

    // 2) sessionStorage 缓存（页面刷新后仍可用）
    const stored = _sessionGet(TOKEN_STORAGE_KEY);
    if (stored) {
        try {
            const parsed = JSON.parse(stored);
            if (parsed.token && parsed.expiresAt && Date.now() < parsed.expiresAt) {
                _tokenCache = parsed;
                return _tokenCache.token;
            }
        } catch (_) {
            // 解析失败，继续走网络请求
        }
    }

    // 3) 校验配置
    if (!FEISHU_CONFIG.APP_ID || !FEISHU_CONFIG.APP_SECRET) {
        throw new Error('飞书 APP_ID 和 APP_SECRET 尚未配置，请先在设置页面完成配置。');
    }

    // 4) 网络请求
    const url = _buildUrl('/auth/v3/tenant_access_token/internal');
    const body = JSON.stringify({
        app_id: FEISHU_CONFIG.APP_ID,
        app_secret: FEISHU_CONFIG.APP_SECRET
    });

    let response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: body
        });
    } catch (networkErr) {
        _handleOffline(networkErr);
        throw new Error('网络请求失败，无法获取飞书 Token: ' + networkErr.message);
    }

    const data = await response.json();

    if (data.code !== 0) {
        const err = _normalizeError(data);
        _emit('error', err);
        throw new Error('获取飞书 Token 失败: [' + err.code + '] ' + err.message);
    }

    const token = data.tenant_access_token;
    const expire = data.expire || TOKEN_TTL;

    // 写入缓存
    _tokenCache = {
        token: token,
        expiresAt: Date.now() + (expire - 300) * 1000 // 提前 5 分钟过期
    };
    _sessionSet(TOKEN_STORAGE_KEY, JSON.stringify(_tokenCache));

    return token;
}

/**
 * 清除当前 Token 缓存（退出登录时调用）。
 */
function clearToken() {
    _tokenCache = null;
    try {
        sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch (_) {
        // 静默
    }
}

// ============================================================
// 5. Core CRUD Operations
// ============================================================

/**
 * 通用请求封装，自动附加 Authorization 头。
 *
 * @async
 * @param {string} method - HTTP 方法（GET / POST / PUT / DELETE / PATCH）
 * @param {string} path   - API 路径（不含域名）
 * @param {Object} [body] - 请求体（GET 请求时不传）
 * @returns {Promise<Object>} 飞书 API 返回的 JSON 数据
 * @private
 */
async function _request(method, path, body) {
    const token = await getTenantToken();

    const options = {
        method: method,
        headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json; charset=utf-8'
        }
    };

    if (body !== undefined && method !== 'GET') {
        options.body = JSON.stringify(body);
    }

    const url = _buildUrl(path);

    let response;
    try {
        response = await fetch(url, options);
    } catch (networkErr) {
        _handleOffline(networkErr);
        throw new Error('网络请求失败: ' + networkErr.message);
    }

    const data = await response.json();

    // Token 过期或无效时自动清除缓存并重试一次
    if (data.code === 99991663 || data.code === 99991664 || data.code === 99991668) {
        clearToken();
        const newToken = await getTenantToken();
        options.headers['Authorization'] = 'Bearer ' + newToken;

        try {
            response = await fetch(url, options);
        } catch (retryErr) {
            _handleOffline(retryErr);
            throw new Error('Token 刷新后重试仍失败: ' + retryErr.message);
        }

        return await response.json();
    }

    return data;
}

/**
 * 离线状态处理。
 * @param {Error} err
 * @private
 */
function _handleOffline(err) {
    if (!_isOffline) {
        _isOffline = true;
        _emit('offline', { message: '网络不可用，已切换到离线模式', error: err });
    }
}

/**
 * 列表/搜索多维表格记录。
 *
 * @async
 * @param {string} tableId    - 数据表 ID
 * @param {Object} [filter]   - 可选筛选条件
 * @param {string} [filter.field]    - 筛选字段名
 * @param {string} [filter.value]    - 筛选值
 * @param {string} [filter.operator] - 筛选运算符（默认 'is'）
 * @param {number} [pageSize=100]    - 每页记录数（最大 500）
 * @param {string} [pageToken]       - 分页 token，用于获取下一页
 * @returns {Promise<{ items: Array, total: number, hasMore: boolean, pageToken: string|null }>}
 */
async function listRecords(tableId, filter, pageSize, pageToken) {
    if (!FEISHU_CONFIG.BASE_TOKEN) {
        throw new Error('飞书多维表格 App Token 尚未配置。');
    }
    if (!tableId) {
        throw new Error('参数 tableId 不能为空。');
    }

    const size = Math.min(Math.max(pageSize || DEFAULT_PAGE_SIZE, 1), 500);
    const params = ['page_size=' + size];
    if (pageToken) {
        params.push('page_token=' + encodeURIComponent(pageToken));
    }

    // 构建筛选条件
    if (filter && filter.field) {
        const filterObj = {
            conjunction: 'and',
            conditions: [{
                field_name: filter.field,
                operator: filter.operator || 'is',
                value: [String(filter.value)]
            }]
        };
        params.push('filter=' + encodeURIComponent(JSON.stringify(filterObj)));
    }

    const path = '/bitable/v1/apps/' + FEISHU_CONFIG.BASE_TOKEN +
                 '/tables/' + tableId + '/records?' + params.join('&');

    const data = await _request('GET', path);

    if (data.code !== 0) {
        const err = _normalizeError(data);
        _emit('error', err);
        throw new Error('查询记录失败: [' + err.code + '] ' + err.message);
    }

    const result = data.data || {};
    return {
        items: result.items || [],
        total: result.total || 0,
        hasMore: result.has_more || false,
        pageToken: result.page_token || null
    };
}

/**
 * 获取单条记录详情。
 *
 * @async
 * @param {string} tableId  - 数据表 ID
 * @param {string} recordId - 记录 ID
 * @returns {Promise<Object>} 记录数据
 */
async function getRecord(tableId, recordId) {
    if (!FEISHU_CONFIG.BASE_TOKEN) {
        throw new Error('飞书多维表格 App Token 尚未配置。');
    }
    if (!tableId || !recordId) {
        throw new Error('参数 tableId 和 recordId 不能为空。');
    }

    const path = '/bitable/v1/apps/' + FEISHU_CONFIG.BASE_TOKEN +
                 '/tables/' + tableId + '/records/' + recordId;

    const data = await _request('GET', path);

    if (data.code !== 0) {
        const err = _normalizeError(data);
        _emit('error', err);
        throw new Error('获取记录失败: [' + err.code + '] ' + err.message);
    }

    return data.data && data.data.record ? data.data.record : {};
}

/**
 * 创建一条新记录。
 *
 * @async
 * @param {string} tableId - 数据表 ID
 * @param {Object} fields  - 记录字段键值对
 * @returns {Promise<Object>} 新创建的记录
 */
async function createRecord(tableId, fields) {
    if (!FEISHU_CONFIG.BASE_TOKEN) {
        throw new Error('飞书多维表格 App Token 尚未配置。');
    }
    if (!tableId) {
        throw new Error('参数 tableId 不能为空。');
    }
    if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) {
        throw new Error('参数 fields 必须为非空对象。');
    }

    // 离线时写入待同步队列
    if (!_isOnline()) {
        _handleOffline(new Error('离线模式'));
        _queuePendingRecord('create', tableId, null, fields);
        return { fields: fields, _offline: true };
    }

    const path = '/bitable/v1/apps/' + FEISHU_CONFIG.BASE_TOKEN +
                 '/tables/' + tableId + '/records';

    const data = await _request('POST', path, { fields: fields });

    if (data.code !== 0) {
        const err = _normalizeError(data);
        _emit('error', err);
        throw new Error('创建记录失败: [' + err.code + '] ' + err.message);
    }

    return data.data && data.data.record ? data.data.record : {};
}

/**
 * 更新已有记录。
 *
 * @async
 * @param {string} tableId  - 数据表 ID
 * @param {string} recordId - 记录 ID
 * @param {Object} fields   - 需要更新的字段键值对
 * @returns {Promise<Object>} 更新后的记录
 */
async function updateRecord(tableId, recordId, fields) {
    if (!FEISHU_CONFIG.BASE_TOKEN) {
        throw new Error('飞书多维表格 App Token 尚未配置。');
    }
    if (!tableId || !recordId) {
        throw new Error('参数 tableId 和 recordId 不能为空。');
    }
    if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) {
        throw new Error('参数 fields 必须为非空对象。');
    }

    // 离线时写入待同步队列
    if (!_isOnline()) {
        _handleOffline(new Error('离线模式'));
        _queuePendingRecord('update', tableId, recordId, fields);
        return { record_id: recordId, fields: fields, _offline: true };
    }

    const path = '/bitable/v1/apps/' + FEISHU_CONFIG.BASE_TOKEN +
                 '/tables/' + tableId + '/records/' + recordId;

    const data = await _request('PUT', path, { fields: fields });

    if (data.code !== 0) {
        const err = _normalizeError(data);
        _emit('error', err);
        throw new Error('更新记录失败: [' + err.code + '] ' + err.message);
    }

    return data.data && data.data.record ? data.data.record : {};
}

/**
 * 删除一条记录。
 *
 * @async
 * @param {string} tableId  - 数据表 ID
 * @param {string} recordId - 记录 ID
 * @returns {Promise<boolean>} 删除是否成功
 */
async function deleteRecord(tableId, recordId) {
    if (!FEISHU_CONFIG.BASE_TOKEN) {
        throw new Error('飞书多维表格 App Token 尚未配置。');
    }
    if (!tableId || !recordId) {
        throw new Error('参数 tableId 和 recordId 不能为空。');
    }

    // 离线时写入待同步队列
    if (!_isOnline()) {
        _handleOffline(new Error('离线模式'));
        _queuePendingRecord('delete', tableId, recordId, null);
        return true;
    }

    const path = '/bitable/v1/apps/' + FEISHU_CONFIG.BASE_TOKEN +
                 '/tables/' + tableId + '/records/' + recordId;

    const data = await _request('DELETE', path);

    if (data.code !== 0) {
        const err = _normalizeError(data);
        _emit('error', err);
        throw new Error('删除记录失败: [' + err.code + '] ' + err.message);
    }

    return true;
}

// ============================================================
// 6. Business Logic Functions
// ============================================================

/**
 * 获取布草资产列表，支持按酒店、品类、状态筛选。
 *
 * @async
 * @param {Object} [filters] - 筛选条件
 * @param {string} [filters.hotelId]  - 酒店 ID
 * @param {string} [filters.category] - 布草品类（床单/被套/枕套/浴巾等）
 * @param {string} [filters.status]   - 状态（在用/洗涤中/报废/库存）
 * @returns {Promise<Array>} 资产记录数组
 */
async function getAssets(filters) {
    const tableId = FEISHU_CONFIG.TABLES.assets;
    if (!tableId) {
        throw new Error('布草资产表 ID 尚未配置。');
    }

    const allItems = [];
    let pageToken = null;

    do {
        const filter = filters ? {
            field: filters.status ? '状态' : (filters.hotelId ? '酒店' : (filters.category ? '品类' : '')),
            value: filters.status || filters.hotelId || filters.category || '',
            operator: 'is'
        } : undefined;

        const result = await listRecords(tableId, filter && filter.field ? filter : undefined, DEFAULT_PAGE_SIZE, pageToken);
        allItems.push(...result.items);
        pageToken = result.hasMore ? result.pageToken : null;
    } while (pageToken);

    // 客户端二次筛选（当存在多个筛选条件时）
    let filtered = allItems;
    if (filters) {
        if (filters.status) {
            const statusVal = String(filters.status);
            filtered = filtered.filter(function (item) {
                var f = item.fields || {};
                return String(f['状态'] || '') === statusVal ||
                       String(f['status'] || '') === statusVal;
            });
        }
        if (filters.hotelId) {
            var hotelVal = String(filters.hotelId);
            filtered = filtered.filter(function (item) {
                var f = item.fields || {};
                return String(f['酒店'] || '') === hotelVal ||
                       String(f['hotel_id'] || '') === hotelVal;
            });
        }
        if (filters.category) {
            var catVal = String(filters.category);
            filtered = filtered.filter(function (item) {
                var f = item.fields || {};
                return String(f['品类'] || '') === catVal ||
                       String(f['category'] || '') === catVal;
            });
        }
    }

    // 离线时尝试从 localStorage 读取
    if (filtered.length === 0 && _isOffline) {
        var localData = loadFromLocal(tableId);
        if (localData) {
            filtered = localData;
        }
    }

    _emit('dataLoaded', { type: 'assets', count: filtered.length });
    return filtered;
}

/**
 * 获取收发记录列表。
 *
 * @async
 * @param {Object} [filters] - 筛选条件
 * @param {string} [filters.type]     - 类型（发出/收回）
 * @param {string} [filters.hotelId]  - 酒店 ID
 * @param {string} [filters.dateFrom] - 起始日期（ISO 格式）
 * @param {string} [filters.dateTo]   - 截止日期（ISO 格式）
 * @returns {Promise<Array>} 收发记录数组
 */
async function getTransactions(filters) {
    const tableId = FEISHU_CONFIG.TABLES.transactions;
    if (!tableId) {
        throw new Error('收发记录表 ID 尚未配置。');
    }

    const allItems = [];
    let pageToken = null;

    do {
        const filter = filters && filters.type ? {
            field: '类型',
            value: filters.type,
            operator: 'is'
        } : undefined;

        const result = await listRecords(tableId, filter, DEFAULT_PAGE_SIZE, pageToken);
        allItems.push(...result.items);
        pageToken = result.hasMore ? result.pageToken : null;
    } while (pageToken);

    // 客户端二次筛选
    let filtered = allItems;
    if (filters) {
        if (filters.hotelId) {
            var hotelVal = String(filters.hotelId);
            filtered = filtered.filter(function (item) {
                var f = item.fields || {};
                return String(f['酒店'] || '') === hotelVal ||
                       String(f['hotel_id'] || '') === hotelVal;
            });
        }
        if (filters.dateFrom || filters.dateTo) {
            filtered = filtered.filter(function (item) {
                var f = item.fields || {};
                var dateStr = String(f['日期'] || f['date'] || '');
                if (!dateStr) return false;
                if (filters.dateFrom && dateStr < filters.dateFrom) return false;
                if (filters.dateTo && dateStr > filters.dateTo) return false;
                return true;
            });
        }
    }

    if (filtered.length === 0 && _isOffline) {
        var localData = loadFromLocal(tableId);
        if (localData) filtered = localData;
    }

    _emit('dataLoaded', { type: 'transactions', count: filtered.length });
    return filtered;
}

/**
 * 获取洗涤记录列表。
 *
 * @async
 * @param {Object} [filters] - 筛选条件
 * @param {string} [filters.status]   - 洗涤状态（洗涤中/已完成/待洗涤）
 * @param {string} [filters.dateFrom] - 起始日期
 * @param {string} [filters.dateTo]   - 截止日期
 * @returns {Promise<Array>} 洗涤记录数组
 */
async function getWashRecords(filters) {
    const tableId = FEISHU_CONFIG.TABLES.wash;
    if (!tableId) {
        throw new Error('洗涤记录表 ID 尚未配置。');
    }

    const allItems = [];
    let pageToken = null;

    do {
        const filter = filters && filters.status ? {
            field: '状态',
            value: filters.status,
            operator: 'is'
        } : undefined;

        const result = await listRecords(tableId, filter, DEFAULT_PAGE_SIZE, pageToken);
        allItems.push(...result.items);
        pageToken = result.hasMore ? result.pageToken : null;
    } while (pageToken);

    let filtered = allItems;
    if (filters && (filters.dateFrom || filters.dateTo)) {
        filtered = filtered.filter(function (item) {
            var f = item.fields || {};
            var dateStr = String(f['日期'] || f['date'] || '');
            if (!dateStr) return false;
            if (filters.dateFrom && dateStr < filters.dateFrom) return false;
            if (filters.dateTo && dateStr > filters.dateTo) return false;
            return true;
        });
    }

    if (filtered.length === 0 && _isOffline) {
        var localData = loadFromLocal(tableId);
        if (localData) filtered = localData;
    }

    _emit('dataLoaded', { type: 'wash', count: filtered.length });
    return filtered;
}

/**
 * 获取所有酒店客户记录。
 *
 * @async
 * @returns {Promise<Array>} 酒店记录数组
 */
async function getHotels() {
    const tableId = FEISHU_CONFIG.TABLES.hotels;
    if (!tableId) {
        throw new Error('酒店客户表 ID 尚未配置。');
    }

    const allItems = [];
    let pageToken = null;

    do {
        const result = await listRecords(tableId, undefined, DEFAULT_PAGE_SIZE, pageToken);
        allItems.push(...result.items);
        pageToken = result.hasMore ? result.pageToken : null;
    } while (pageToken);

    if (allItems.length === 0 && _isOffline) {
        var localData = loadFromLocal(tableId);
        if (localData) return localData;
    }

    _emit('dataLoaded', { type: 'hotels', count: allItems.length });
    return allItems;
}

/**
 * 获取库存盘点记录。
 *
 * @async
 * @returns {Promise<Array>} 盘点记录数组
 */
async function getInventoryChecks() {
    const tableId = FEISHU_CONFIG.TABLES.inventory;
    if (!tableId) {
        throw new Error('库存盘点表 ID 尚未配置。');
    }

    const allItems = [];
    let pageToken = null;

    do {
        const result = await listRecords(tableId, undefined, DEFAULT_PAGE_SIZE, pageToken);
        allItems.push(...result.items);
        pageToken = result.hasMore ? result.pageToken : null;
    } while (pageToken);

    if (allItems.length === 0 && _isOffline) {
        var localData = loadFromLocal(tableId);
        if (localData) return localData;
    }

    _emit('dataLoaded', { type: 'inventory', count: allItems.length });
    return allItems;
}

/**
 * 获取仪表盘汇总统计数据。
 *
 * 聚合以下指标：
 * - 资产总数
 * - 在用数量
 * - 洗涤中数量
 * - 库存数量
 * - 报废数量
 * - 告警数量（低库存或即将到期）
 *
 * @async
 * @returns {Promise<Object>} 汇总统计对象
 */
async function getDashboardSummary() {
    var summary = {
        totalAssets: 0,
        inUse: 0,
        washing: 0,
        inStock: 0,
        scrapped: 0,
        alerts: 0,
        hotels: 0,
        lastUpdated: new Date().toISOString()
    };

    try {
        // 并行请求资产和酒店数据
        var results = await Promise.allSettled([
            getAssets({}),
            getHotels()
        ]);

        var assetsResult = results[0];
        var hotelsResult = results[1];

        if (assetsResult.status === 'fulfilled') {
            var assets = assetsResult.value || [];
            summary.totalAssets = assets.length;

            assets.forEach(function (item) {
                var f = item.fields || {};
                var status = String(f['状态'] || f['status'] || '').trim();

                switch (status) {
                    case '在用':
                    case '在库':
                    case '使用中':
                        summary.inUse++;
                        break;
                    case '洗涤中':
                    case '清洗中':
                        summary.washing++;
                        break;
                    case '库存':
                    case '闲置':
                    case '仓库':
                        summary.inStock++;
                        break;
                    case '报废':
                    case '损坏':
                    case '已报废':
                        summary.scrapped++;
                        break;
                    default:
                        // 未知状态归入库存
                        summary.inStock++;
                }
            });

            // 告警规则：库存低于 10 的品类
            var categoryCount = {};
            assets.forEach(function (item) {
                var f = item.fields || {};
                var cat = String(f['品类'] || f['category'] || '未分类');
                var status = String(f['状态'] || f['status'] || '');
                if (status === '库存' || status === '闲置' || status === '仓库') {
                    categoryCount[cat] = (categoryCount[cat] || 0) + 1;
                }
            });
            Object.keys(categoryCount).forEach(function (cat) {
                if (categoryCount[cat] < 10) {
                    summary.alerts++;
                }
            });
        }

        if (hotelsResult.status === 'fulfilled') {
            summary.hotels = (hotelsResult.value || []).length;
        }
    } catch (err) {
        console.error('[FeishuAPI] 获取仪表盘汇总失败:', err);
        _emit('error', _normalizeError(err));
    }

    _emit('dataLoaded', { type: 'summary', data: summary });
    return summary;
}

// ============================================================
// 7. Offline Support (localStorage Fallback)
// ============================================================

/**
 * 将数据保存到 localStorage 作为离线缓存。
 *
 * @param {string} tableId - 数据表 ID（用作存储 key 的一部分）
 * @param {Array|Object} data - 要缓存的数据
 */
function saveToLocal(tableId, data) {
    if (!tableId) return;
    var key = OFFLINE_PREFIX + tableId;
    var payload = {
        data: data,
        savedAt: new Date().toISOString(),
        tableId: tableId
    };
    _localSet(key, JSON.stringify(payload));
}

/**
 * 从 localStorage 读取离线缓存数据。
 *
 * @param {string} tableId - 数据表 ID
 * @returns {Array|Object|null} 缓存的数据，无缓存时返回 null
 */
function loadFromLocal(tableId) {
    if (!tableId) return null;
    var key = OFFLINE_PREFIX + tableId;
    var raw = _localGet(key);
    if (!raw) return null;

    try {
        var parsed = JSON.parse(raw);
        return parsed.data || null;
    } catch (_) {
        return null;
    }
}

/**
 * 将一条待同步操作加入队列。
 *
 * @param {string} action   - 操作类型（create / update / delete）
 * @param {string} tableId  - 数据表 ID
 * @param {string|null} recordId - 记录 ID（create 时为 null）
 * @param {Object|null} fields   - 字段数据（delete 时为 null）
 * @private
 */
function _queuePendingRecord(action, tableId, recordId, fields) {
    var pending = _loadPendingQueue();
    pending.push({
        action: action,
        tableId: tableId,
        recordId: recordId,
        fields: fields,
        queuedAt: new Date().toISOString()
    });
    _localSet(PENDING_PREFIX + 'queue', JSON.stringify(pending));
}

/**
 * 读取待同步队列。
 * @returns {Array}
 * @private
 */
function _loadPendingQueue() {
    var raw = _localGet(PENDING_PREFIX + 'queue');
    if (!raw) return [];
    try {
        return JSON.parse(raw);
    } catch (_) {
        return [];
    }
}

/**
 * 批量同步离线期间暂存的记录到飞书。
 *
 * 在网络恢复后调用此方法，将队列中的 create / update / delete 操作
 * 按顺序逐一提交到飞书 API。成功的操作从队列中移除，失败的保留。
 *
 * @async
 * @returns {Promise<{ synced: number, failed: number, remaining: number }>}
 */
async function syncPendingRecords() {
    if (!_isOnline()) {
        _emit('offline', { message: '当前仍处于离线状态，无法同步。' });
        return { synced: 0, failed: 0, remaining: 0 };
    }

    var queue = _loadPendingQueue();
    if (queue.length === 0) {
        return { synced: 0, failed: 0, remaining: 0 };
    }

    var synced = 0;
    var failed = 0;
    var remaining = [];

    for (var i = 0; i < queue.length; i++) {
        var op = queue[i];
        try {
            switch (op.action) {
                case 'create':
                    await createRecord(op.tableId, op.fields);
                    break;
                case 'update':
                    await updateRecord(op.tableId, op.recordId, op.fields);
                    break;
                case 'delete':
                    await deleteRecord(op.tableId, op.recordId);
                    break;
                default:
                    continue;
            }
            synced++;
        } catch (err) {
            failed++;
            remaining.push(op);
            console.warn('[FeishuAPI] 同步失败:', op.action, op.tableId, err.message);
        }
    }

    // 更新队列：只保留失败的
    _localSet(PENDING_PREFIX + 'queue', JSON.stringify(remaining));

    if (synced > 0) {
        _isOffline = false;
        _emit('dataLoaded', { type: 'sync', synced: synced, failed: failed });
    }

    return { synced: synced, failed: failed, remaining: remaining.length };
}

/**
 * 获取当前待同步队列的长度。
 *
 * @returns {number} 待同步记录数
 */
function getPendingCount() {
    return _loadPendingQueue().length;
}

/**
 * 清除所有离线缓存和待同步队列。
 */
function clearOfflineData() {
    var keysToRemove = [];
    try {
        for (var i = 0; i < localStorage.length; i++) {
            var key = localStorage.key(i);
            if (key && (key.indexOf(OFFLINE_PREFIX) === 0 || key.indexOf(PENDING_PREFIX) === 0)) {
                keysToRemove.push(key);
            }
        }
    } catch (_) {
        // 静默
    }
    keysToRemove.forEach(function (key) {
        _localRemove(key);
    });
}

// ============================================================
// 8. Utility Functions
// ============================================================

/**
 * 将 ISO 日期字符串格式化为可读的中文日期格式。
 *
 * 支持以下输入格式：
 * - 完整 ISO: "2026-04-26T10:30:00.000Z"
 * - 日期部分: "2026-04-26"
 * - 时间戳: 1714117800000
 *
 * @param {string|number|Date} isoString - ISO 日期字符串、时间戳或 Date 对象
 * @returns {string} 格式化后的日期字符串，如 "2026年4月26日 10:30"
 */
function formatDate(isoString) {
    if (!isoString) return '-';
    var date;
    if (isoString instanceof Date) {
        date = isoString;
    } else if (typeof isoString === 'number') {
        date = new Date(isoString);
    } else {
        date = new Date(isoString);
    }

    if (isNaN(date.getTime())) return String(isoString);

    var year = date.getFullYear();
    var month = date.getMonth() + 1;
    var day = date.getDate();
    var hours = date.getHours();
    var minutes = date.getMinutes();

    var str = year + '年' + month + '月' + day + '日';
    if (hours !== 0 || minutes !== 0) {
        str += ' ' + String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0');
    }
    return str;
}

/**
 * 将状态代码映射为中文标签。
 *
 * 支持中英文状态值，返回统一的中文显示文本。
 *
 * @param {string} status - 状态代码
 * @returns {string} 中文状态标签
 *
 * @example
 * formatStatus('在用')     // => '在用'
 * formatStatus('washing')  // => '洗涤中'
 * formatStatus('scrapped') // => '报废'
 * formatStatus('')         // => '未知'
 */
function formatStatus(status) {
    if (!status) return '未知';

    var map = {
        // 中文状态
        '在用': '在用',
        '使用中': '在用',
        '在库': '在用',
        '洗涤中': '洗涤中',
        '清洗中': '洗涤中',
        '待洗涤': '待洗涤',
        '报废': '报废',
        '已报废': '报废',
        '损坏': '报废',
        '库存': '库存',
        '闲置': '库存',
        '仓库': '库存',
        '发出': '已发出',
        '收回': '已收回',
        '已完成': '已完成',
        // 英文状态
        'in_use': '在用',
        'washing': '洗涤中',
        'washed': '已完成',
        'scrapped': '报废',
        'damaged': '报废',
        'stock': '库存',
        'idle': '库存',
        'sent': '已发出',
        'received': '已收回',
        'completed': '已完成',
        'pending': '待洗涤'
    };

    var key = String(status).trim().toLowerCase();
    // 先精确匹配（保留原始大小写）
    if (map[String(status).trim()]) {
        return map[String(status).trim()];
    }
    // 再小写匹配
    return map[key] || '未知';
}

/**
 * 将表格数据导出为 CSV 文件并触发浏览器下载。
 *
 * @param {Array<Object>} data    - 记录数组，每条记录包含 fields 属性
 * @param {string}        filename - 下载文件名（不含扩展名，自动添加 .csv）
 */
function exportToCSV(data, filename) {
    if (!data || data.length === 0) {
        console.warn('[FeishuAPI] exportToCSV: 数据为空，无法导出。');
        return;
    }

    // 收集所有字段名作为表头
    var headerSet = {};
    data.forEach(function (item) {
        var fields = item.fields || item;
        Object.keys(fields).forEach(function (key) {
            headerSet[key] = true;
        });
    });
    var headers = Object.keys(headerSet);

    // 构建 CSV 行
    var csvRows = [];
    // 表头
    csvRows.push(headers.map(_escapeCSV).join(','));
    // 数据行
    data.forEach(function (item) {
        var fields = item.fields || item;
        var row = headers.map(function (h) {
            var val = fields[h];
            if (val === undefined || val === null) return '';
            if (Array.isArray(val)) return val.map(String).join(';');
            return String(val);
        });
        csvRows.push(row.map(_escapeCSV).join(','));
    });

    var csvContent = '\uFEFF' + csvRows.join('\n'); // BOM 头确保 Excel 正确识别 UTF-8

    // 创建 Blob 并触发下载
    var blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    var link = document.createElement('a');
    var url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', (filename || 'export') + '.csv');
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

/**
 * CSV 字段转义：包含逗号、引号或换行时用双引号包裹。
 * @param {string} field
 * @returns {string}
 * @private
 */
function _escapeCSV(field) {
    var str = String(field);
    if (str.indexOf(',') !== -1 || str.indexOf('"') !== -1 || str.indexOf('\n') !== -1) {
        return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}

// ============================================================
// 9. Event System
// ============================================================

/**
 * 注册事件监听器。
 *
 * 支持的事件类型：
 * - `dataLoaded` — 数据加载完成时触发，回调参数: `{ type: string, count?: number, data?: Object }`
 * - `error`      — API 错误时触发，回调参数: `{ code: number, message: string, raw: Object }`
 * - `offline`    — 网络不可用时触发，回调参数: `{ message: string, error?: Error }`
 *
 * @param {string}   event    - 事件名称
 * @param {Function} callback - 回调函数
 * @returns {Function} 取消监听的函数（调用即移除该回调）
 *
 * @example
 * const unsubscribe = FeishuAPI.on('error', (err) => {
 *     console.error('API 错误:', err.message);
 * });
 * // 取消监听
 * unsubscribe();
 */
function on(event, callback) {
    if (typeof callback !== 'function') {
        throw new TypeError('回调参数必须为函数。');
    }
    if (!_eventListeners[event]) {
        _eventListeners[event] = [];
    }
    _eventListeners[event].push(callback);

    // 返回取消订阅函数
    return function () {
        var list = _eventListeners[event];
        if (list) {
            var idx = list.indexOf(callback);
            if (idx !== -1) {
                list.splice(idx, 1);
            }
        }
    };
}

/**
 * 移除指定事件的所有监听器。
 *
 * @param {string} [event] - 事件名称。不传则移除所有事件的监听器。
 */
function off(event) {
    if (event) {
        _eventListeners[event] = [];
    } else {
        Object.keys(_eventListeners).forEach(function (key) {
            _eventListeners[key] = [];
        });
    }
}

// ============================================================
// 10. Network Status Monitoring
// ============================================================

/**
 * 初始化网络状态监听，自动检测在线/离线切换。
 * 页面加载后应调用一次。
 */
function initNetworkMonitor() {
    if (typeof window === 'undefined') return;

    window.addEventListener('online', function () {
        if (_isOffline) {
            _isOffline = false;
            console.log('[FeishuAPI] 网络已恢复，尝试同步离线数据...');
            _emit('dataLoaded', { type: 'online' });
            syncPendingRecords().then(function (result) {
                if (result.synced > 0) {
                    console.log('[FeishuAPI] 同步完成: ' + result.synced + ' 条成功, ' + result.failed + ' 条失败');
                }
            });
        }
    });

    window.addEventListener('offline', function () {
        _handleOffline(new Error('浏览器检测到网络断开'));
    });
}

// ============================================================
// 11. Configuration Helpers
// ============================================================

/**
 * 批量更新飞书 API 配置。
 * 通常在仪表盘设置页面保存时调用。
 *
 * @param {Object} config - 配置对象（与 FEISHU_CONFIG 结构一致）
 * @param {string} [config.APP_ID]
 * @param {string} [config.APP_SECRET]
 * @param {string} [config.BASE_TOKEN]
 * @param {Object} [config.TABLES]
 * @param {string} [config.CORS_PROXY]
 *
 * @example
 * FeishuAPI.configure({
 *     APP_ID: 'cli_xxx',
 *     APP_SECRET: 'xxx',
 *     BASE_TOKEN: 'bascnxxx',
 *     TABLES: { assets: 'tblxxx', ... }
 * });
 */
function configure(config) {
    if (!config || typeof config !== 'object') return;

    if (config.APP_ID !== undefined) FEISHU_CONFIG.APP_ID = config.APP_ID;
    if (config.APP_SECRET !== undefined) FEISHU_CONFIG.APP_SECRET = config.APP_SECRET;
    if (config.BASE_TOKEN !== undefined) FEISHU_CONFIG.BASE_TOKEN = config.BASE_TOKEN;
    if (config.CORS_PROXY !== undefined) FEISHU_CONFIG.CORS_PROXY = config.CORS_PROXY;

    if (config.TABLES && typeof config.TABLES === 'object') {
        Object.keys(config.TABLES).forEach(function (key) {
            if (FEISHU_CONFIG.TABLES.hasOwnProperty(key)) {
                FEISHU_CONFIG.TABLES[key] = config.TABLES[key];
            }
        });
    }

    // 配置变更后清除旧 Token
    clearToken();
}

/**
 * 获取当前配置的副本（敏感字段可选择性隐藏）。
 *
 * @param {boolean} [maskSecrets=false] - 是否隐藏 APP_SECRET 等敏感字段
 * @returns {Object} 当前配置的深拷贝
 */
function getConfig(maskSecrets) {
    var copy = JSON.parse(JSON.stringify(FEISHU_CONFIG));
    if (maskSecrets) {
        if (copy.APP_SECRET) copy.APP_SECRET = copy.APP_SECRET.replace(/./g, '*').substring(0, 8);
    }
    return copy;
}

/**
 * 验证当前配置是否完整可用。
 *
 * @returns {{ valid: boolean, missing: string[] }} 验证结果
 */
function validateConfig() {
    var missing = [];
    if (!FEISHU_CONFIG.APP_ID) missing.push('APP_ID');
    if (!FEISHU_CONFIG.APP_SECRET) missing.push('APP_SECRET');
    if (!FEISHU_CONFIG.BASE_TOKEN) missing.push('BASE_TOKEN');

    Object.keys(FEISHU_CONFIG.TABLES).forEach(function (key) {
        if (!FEISHU_CONFIG.TABLES[key]) {
            missing.push('TABLES.' + key);
        }
    });

    return {
        valid: missing.length === 0,
        missing: missing
    };
}

// ============================================================
// 12. Singleton Export
// ============================================================

/**
 * FeishuAPI 单例对象。
 *
 * 汇总所有公开方法，作为模块的唯一入口。
 * 在 HTML 中通过 `<script>` 引入后，全局可用 `window.FeishuAPI`。
 *
 * @global
 * @namespace FeishuAPI
 *
 * @example
 * // 引入脚本
 * <script src="js/feishu-api.js"></script>
 *
 * // 配置
 * FeishuAPI.configure({ APP_ID: '...', APP_SECRET: '...', BASE_TOKEN: '...' });
 *
 * // 获取数据
 * FeishuAPI.getAssets({ status: '在用' }).then(assets => {
 *     console.log('在用布草:', assets.length);
 * });
 *
 * // 监听事件
 * FeishuAPI.on('error', err => console.error(err));
 */
const FeishuAPI = {
    // --- 配置 ---
    configure: configure,
    getConfig: getConfig,
    validateConfig: validateConfig,

    // --- Token 管理 ---
    getTenantToken: getTenantToken,
    clearToken: clearToken,

    // --- CRUD 操作 ---
    listRecords: listRecords,
    getRecord: getRecord,
    createRecord: createRecord,
    updateRecord: updateRecord,
    deleteRecord: deleteRecord,

    // --- 业务逻辑 ---
    getAssets: getAssets,
    getTransactions: getTransactions,
    getWashRecords: getWashRecords,
    getHotels: getHotels,
    getInventoryChecks: getInventoryChecks,
    getDashboardSummary: getDashboardSummary,

    // --- 离线支持 ---
    saveToLocal: saveToLocal,
    loadFromLocal: loadFromLocal,
    syncPendingRecords: syncPendingRecords,
    getPendingCount: getPendingCount,
    clearOfflineData: clearOfflineData,

    // --- 工具函数 ---
    formatDate: formatDate,
    formatStatus: formatStatus,
    exportToCSV: exportToCSV,

    // --- 事件系统 ---
    on: on,
    off: off,

    // --- 网络监控 ---
    initNetworkMonitor: initNetworkMonitor,

    // --- 配置引用（只读副本） ---
    get config() {
        return getConfig(false);
    }
};

// 导出到全局作用域
if (typeof window !== 'undefined') {
    window.FeishuAPI = FeishuAPI;
}

// 页面加载后自动初始化网络监听
if (typeof document !== 'undefined' && document.readyState === 'complete') {
    initNetworkMonitor();
} else if (typeof window !== 'undefined') {
    window.addEventListener('DOMContentLoaded', initNetworkMonitor);
}
