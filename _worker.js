async function initDatabase(config) {
  console.log("开始数据库初始化...");
  if (!config || !config.database) {
    console.error("数据库配置缺失");
    throw new Error("数据库配置无效，请检查D1数据库是否正确绑定");
  }
  if (!config.fileCache) {
    config.fileCache = new Map();
    config.fileCacheTTL = 3600000;
  }
  const maxRetries = 3;
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`正在测试数据库连接... (尝试 ${attempt}/${maxRetries})`);
      await config.database.prepare("SELECT 1").run();
      console.log("数据库连接成功");
      console.log("正在验证数据库结构...");
      const structureValid = await validateDatabaseStructure(config);
      if (!structureValid) {
        throw new Error("数据库结构验证失败");
      }
      console.log("数据库初始化成功");
      return true;
    } catch (error) {
      lastError = error;
      console.error(`数据库初始化尝试 ${attempt} 失败:`, error);
      if (error.message.includes('no such table')) {
        console.log("检测到数据表不存在，尝试创建...");
        try {
          await recreateAllTables(config);
          console.log("数据表创建成功");
          return true;
        } catch (tableError) {
          console.error("创建数据表失败:", tableError);
        }
      }
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        console.log(`等待 ${delay}ms 后重试...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw new Error(`数据库初始化失败 (${maxRetries} 次尝试): ${lastError?.message || '未知错误'}`);
}
async function recreateAllTables(config) {
  try {
    await config.database.prepare(`
      CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
    await config.database.prepare(`
      CREATE TABLE IF NOT EXISTS user_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL UNIQUE,
        storage_type TEXT DEFAULT 'telegram',
        current_category_id INTEGER,
        waiting_for TEXT,
        editing_file_id TEXT,
        FOREIGN KEY (current_category_id) REFERENCES categories(id)
      )
    `).run();
    
    await config.database.prepare(`
      CREATE TABLE IF NOT EXISTS allowed_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL UNIQUE,
        added_by TEXT,
        created_at INTEGER NOT NULL
      )
    `).run();
    
    await config.database.prepare(`
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        fileId TEXT,
        message_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        file_name TEXT,
        file_size INTEGER,
        mime_type TEXT,
        storage_type TEXT DEFAULT 'telegram',
        category_id INTEGER,
        chat_id TEXT,
        FOREIGN KEY (category_id) REFERENCES categories(id)
      )
    `).run();
    await config.database.prepare(`
      INSERT OR IGNORE INTO categories (name) VALUES ('默认分类')
    `).run();
    return true;
  } catch (error) {
    console.error("重新创建表失败:", error);
    throw error;
  }
}
async function validateDatabaseStructure(config) {
  try {
    const tables = [
      'categories',
      'user_settings',
      'allowed_users',
      'files'
    ];
    for (const table of tables) {
      try {
        await config.database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).run();
      } catch (error) {
        if (error.message.includes('no such table')) {
          console.log(`表 ${table} 不存在，尝试重新创建所有表...`);
          await recreateAllTables(config);
          return true;
        }
        throw error;
      }
    }
    const tableStructures = {
      categories: [
        { name: 'id', type: 'INTEGER' },
        { name: 'name', type: 'TEXT' },
        { name: 'created_at', type: 'DATETIME' }
      ],
      user_settings: [
        { name: 'id', type: 'INTEGER' },
        { name: 'chat_id', type: 'TEXT' },
        { name: 'storage_type', type: 'TEXT' },
        { name: 'current_category_id', type: 'INTEGER' },
        { name: 'waiting_for', type: 'TEXT' },
        { name: 'editing_file_id', type: 'TEXT' },
        { name: 'is_processing', type: 'INTEGER' },
        { name: 'lock_time', type: 'INTEGER' },
        { name: 'upload_seq', type: 'INTEGER' }
      ],
      allowed_users: [
        { name: 'id', type: 'INTEGER' },
        { name: 'chat_id', type: 'TEXT' },
        { name: 'added_by', type: 'TEXT' },
        { name: 'created_at', type: 'INTEGER' }
      ],
      files: [
        { name: 'id', type: 'INTEGER' },
        { name: 'url', type: 'TEXT' },
        { name: 'fileId', type: 'TEXT' },
        { name: 'message_id', type: 'INTEGER' },
        { name: 'created_at', type: 'DATETIME' },
        { name: 'file_name', type: 'TEXT' },
        { name: 'file_size', type: 'INTEGER' },
        { name: 'mime_type', type: 'TEXT' },
        { name: 'storage_type', type: 'TEXT' },
        { name: 'category_id', type: 'INTEGER' },
        { name: 'chat_id', type: 'TEXT' }
      ]
    };
    for (const [table, expectedColumns] of Object.entries(tableStructures)) {
      const tableInfo = await config.database.prepare(`PRAGMA table_info(${table})`).all();
      const actualColumns = tableInfo.results;
      for (const expectedColumn of expectedColumns) {
        const found = actualColumns.some(col => 
          col.name.toLowerCase() === expectedColumn.name.toLowerCase() &&
          col.type.toUpperCase().includes(expectedColumn.type)
        );
        if (!found) {
          console.log(`表 ${table} 缺少列 ${expectedColumn.name}，尝试添加...`);
          try {
            await config.database.prepare(`ALTER TABLE ${table} ADD COLUMN ${expectedColumn.name} ${expectedColumn.type}`).run();
  } catch (error) {
            if (!error.message.includes('duplicate column name')) {
              throw error;
            }
          }
        }
      }
    }
    console.log('检查默认分类...');
    const defaultCategory = await config.database.prepare('SELECT id FROM categories WHERE name = ?')
      .bind('默认分类').first();
    if (!defaultCategory) {
      console.log('默认分类不存在，正在创建...');
      try {
        const result = await config.database.prepare('INSERT INTO categories (name, created_at) VALUES (?, ?)')
          .bind('默认分类', Date.now()).run();
        const newDefaultId = result.meta && result.meta.last_row_id;
        console.log(`默认分类创建成功，ID: ${newDefaultId}`);
        if (newDefaultId) {
          const filesResult = await config.database.prepare('SELECT COUNT(*) as count FROM files WHERE category_id IS NULL').first();
          if (filesResult && filesResult.count > 0) {
            console.log(`发现 ${filesResult.count} 个无分类文件，将它们分配到默认分类...`);
            await config.database.prepare('UPDATE files SET category_id = ? WHERE category_id IS NULL')
              .bind(newDefaultId).run();
          }
          const settingsResult = await config.database.prepare('SELECT COUNT(*) as count FROM user_settings WHERE current_category_id IS NULL').first();
          if (settingsResult && settingsResult.count > 0) {
            console.log(`发现 ${settingsResult.count} 条用户设置没有当前分类，更新为默认分类...`);
            await config.database.prepare('UPDATE user_settings SET current_category_id = ? WHERE current_category_id IS NULL')
              .bind(newDefaultId).run();
          }
        }
      } catch (error) {
        console.error('创建默认分类失败:', error);
        throw new Error('无法创建默认分类: ' + error.message);
      }
    } else {
      console.log(`默认分类存在，ID: ${defaultCategory.id}`);
    }
    const checkAgain = await config.database.prepare('SELECT id FROM categories WHERE name = ?')
      .bind('默认分类').first();
    if (!checkAgain) {
      throw new Error('验证失败：即使尝试创建后，默认分类仍然不存在');
    }
    return true;
  } catch (error) {
    console.error('验证数据库结构时出错:', error);
    return false;
  }
}
async function recreateCategoriesTable(config) {
  try {
    const existingData = await config.database.prepare('SELECT * FROM categories').all();
    await config.database.prepare('DROP TABLE IF EXISTS categories').run();
    await config.database.prepare(`
      CREATE TABLE categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      )
    `).run();
    if (existingData && existingData.results && existingData.results.length > 0) {
      for (const row of existingData.results) {
        await config.database.prepare('INSERT OR IGNORE INTO categories (id, name, created_at) VALUES (?, ?, ?)')
          .bind(row.id || null, row.name || '未命名分类', row.created_at || Date.now()).run();
      }
      console.log(`已恢复 ${existingData.results.length} 个分类数据`);
    }
    console.log("分类表重建完成");
  } catch (error) {
    console.error(`重建分类表失败: ${error.message}`);
  }
}
async function recreateUserSettingsTable(config) {
  try {
    await config.database.prepare('DROP TABLE IF EXISTS user_settings').run();
    await config.database.prepare(`
      CREATE TABLE user_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL UNIQUE,
        storage_type TEXT DEFAULT 'telegram',
        category_id INTEGER,
        custom_suffix TEXT,
        waiting_for TEXT,
        editing_file_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
    console.log('用户设置表重新创建成功');
    return true;
  } catch (error) {
    console.error('重新创建用户设置表失败:', error);
    return false;
  }
}
async function recreateFilesTable(config) {
  console.log('开始重建文件表...');
  try {
    console.log('备份现有数据...');
    const existingData = await config.database.prepare('SELECT * FROM files').all();
    console.log('删除现有表...');
    await config.database.prepare('DROP TABLE IF EXISTS files').run();
    console.log('创建新表...');
    await config.database.prepare(`
      CREATE TABLE files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        fileId TEXT NOT NULL,
        message_id INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        file_name TEXT,
        file_size INTEGER,
        mime_type TEXT,
        chat_id TEXT,
        storage_type TEXT NOT NULL DEFAULT 'telegram',
        category_id INTEGER,
        custom_suffix TEXT,
        FOREIGN KEY (category_id) REFERENCES categories(id)
      )
    `).run();
    console.log('恢复数据...');
    if (existingData && existingData.results && existingData.results.length > 0) {
      console.log(`恢复 ${existingData.results.length} 条记录...`);
      for (const row of existingData.results) {
        const timestamp = row.created_at || Math.floor(Date.now() / 1000);
        const messageId = row.message_id || 0;
        try {
          await config.database.prepare(`
            INSERT INTO files (
              url, fileId, message_id, created_at, file_name, file_size, 
              mime_type, chat_id, storage_type, category_id, custom_suffix
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            row.url, 
            row.fileId || row.url, 
            messageId,
            timestamp,
            row.file_name, 
            row.file_size, 
            row.mime_type, 
            row.chat_id, 
            row.storage_type || 'telegram', 
            row.category_id,
            row.custom_suffix
          ).run();
        } catch (e) {
          console.error(`恢复记录失败: ${e.message}`, row);
        }
      }
    }
    console.log('文件表重建完成!');
    return true;
  } catch (error) {
    console.error('重建文件表失败:', error);
    return false;
  }
}
async function checkAndAddMissingColumns(config) {
  try {
    await ensureColumnExists(config, 'files', 'custom_suffix', 'TEXT');
    await ensureColumnExists(config, 'files', 'chat_id', 'TEXT');
    await ensureColumnExists(config, 'user_settings', 'custom_suffix', 'TEXT');
    await ensureColumnExists(config, 'user_settings', 'waiting_for', 'TEXT');
    await ensureColumnExists(config, 'user_settings', 'editing_file_id', 'TEXT');
    await ensureColumnExists(config, 'user_settings', 'current_category_id', 'INTEGER');
    await ensureColumnExists(config, 'user_settings', 'is_processing', 'INTEGER');   // 新增
    await ensureColumnExists(config, 'user_settings', 'upload_seq', 'INTEGER');      // 新增：用于排队序号
    return true;
  } catch (error) {
    console.error('检查并添加缺失列失败:', error);
    return false;
  }
}
// 尝试获取该 chat_id 的上传锁，同时分配一个排队序号
async function acquireUploadLock(chatId, config, maxWaitMs = 20000, pollMs = 300, lockTimeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const now = Date.now();
    const result = await config.database.prepare(
      `UPDATE user_settings 
       SET is_processing = 1, lock_time = ?
       WHERE chat_id = ? AND (
         is_processing IS NULL OR is_processing = 0 
         OR (lock_time IS NOT NULL AND ? - lock_time > ?)
       )`
    ).bind(now, chatId, now, lockTimeoutMs).run();
    if (result.meta && result.meta.changes > 0) return true;
    await new Promise(r => setTimeout(r, pollMs));
  }
  return false;
}

async function releaseUploadLock(chatId, config) {
  try {
    await config.database.prepare(
      'UPDATE user_settings SET is_processing = 0 WHERE chat_id = ?'
    ).bind(chatId).run();
  } catch (error) {
    console.error('释放上传锁失败:', error);
  }
}
async function ensureColumnExists(config, tableName, columnName, columnType) {
  console.log(`确保列 ${columnName} 存在于表 ${tableName} 中...`); 
  try {
    console.log(`检查列 ${columnName} 是否存在于 ${tableName}...`); 
    const tableInfo = await config.database.prepare(`PRAGMA table_info(${tableName})`).all();
    const columnExists = tableInfo.results.some(col => col.name === columnName);
    if (columnExists) {
      console.log(`列 ${columnName} 已存在于表 ${tableName} 中`);
      return true; 
    }
    console.log(`列 ${columnName} 不存在于表 ${tableName}，尝试添加...`); 
    try {
      await config.database.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`).run();
      console.log(`列 ${columnName} 已成功添加到表 ${tableName}`);
      return true; 
    } catch (alterError) {
      console.warn(`添加列 ${columnName} 到 ${tableName} 时发生错误: ${alterError.message}. 尝试再次检查列是否存在...`, alterError); 
      const tableInfoAfterAttempt = await config.database.prepare(`PRAGMA table_info(${tableName})`).all();
      if (tableInfoAfterAttempt.results.some(col => col.name === columnName)) {
         console.log(`列 ${columnName} 在添加尝试失败后被发现存在于表 ${tableName} 中。`);
         return true; 
      } else {
         console.error(`添加列 ${columnName} 到 ${tableName} 失败，并且再次检查后列仍不存在。`);
         return false; 
      }
    }
  } catch (error) {
    console.error(`检查或添加表 ${tableName} 中的列 ${columnName} 时发生严重错误: ${error.message}`, error);
    return false; 
  }
}
// 将英文逗号分隔的 ID 转为数组
function normalizeIdList(value) {
  return String(value || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);
}

// 检查是否为 TG_ADMIN_ID 管理员
function isTelegramAdmin(chatId, config) {
  const normalizedId = String(chatId || '').trim();

  return (
    Array.isArray(config.tgAdminId) &&
    config.tgAdminId.includes(normalizedId)
  );
}

// 验证 Telegram 私聊用户 ID
function normalizeTelegramUserId(value) {
  const normalizedId = String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();

  // 当前代码忽略群组消息，所以这里只接受正整数用户 ID
  if (!/^\d{5,20}$/.test(normalizedId)) {
    return null;
  }

  return normalizedId;
}

// 判断用户是否有权使用机器人
async function isAllowedTelegramUser(chatId, config) {
  const normalizedId = String(chatId || '').trim();

  // 管理员永远直接放行
  if (isTelegramAdmin(normalizedId, config)) {
    return true;
  }

  const user = await config.database.prepare(`
    SELECT chat_id
    FROM allowed_users
    WHERE chat_id = ?
    LIMIT 1
  `).bind(normalizedId).first();

  return !!user;
}

// 获取所有普通授权用户
async function listAllowedTelegramUsers(config) {
  const result = await config.database.prepare(`
    SELECT
      id,
      chat_id,
      added_by,
      created_at
    FROM allowed_users
    ORDER BY created_at DESC, id DESC
  `).all();

  const users = result.results || [];

  // 防止管理员同时出现在普通用户列表中
  return users.filter(user => {
    return !isTelegramAdmin(user.chat_id, config);
  });
}

// 添加普通授权用户
async function addAllowedTelegramUser(chatId, addedBy, config) {
  const normalizedId = normalizeTelegramUserId(chatId);

  if (!normalizedId) {
    throw new Error('用户 ID 格式不正确');
  }

  // 管理员本身不需要写入 allowed_users
  if (isTelegramAdmin(normalizedId, config)) {
    return {
      chatId: normalizedId,
      created: false,
      alreadyAdmin: true
    };
  }

  const existing = await config.database.prepare(`
    SELECT id
    FROM allowed_users
    WHERE chat_id = ?
    LIMIT 1
  `).bind(normalizedId).first();

  if (existing) {
    return {
      chatId: normalizedId,
      created: false,
      alreadyAdmin: false
    };
  }

  await config.database.prepare(`
    INSERT INTO allowed_users (
      chat_id,
      added_by,
      created_at
    )
    VALUES (?, ?, ?)
  `).bind(
    normalizedId,
    String(addedBy || ''),
    Date.now()
  ).run();

  return {
    chatId: normalizedId,
    created: true,
    alreadyAdmin: false
  };
}

// 删除普通用户授权
async function removeAllowedTelegramUser(chatId, config) {
  const normalizedId = normalizeTelegramUserId(chatId);

  if (!normalizedId) {
    throw new Error('用户 ID 格式不正确');
  }

  // 禁止删除 TG_ADMIN_ID
  if (isTelegramAdmin(normalizedId, config)) {
    throw new Error('TG_ADMIN_ID 管理员不能被删除');
  }

  const result = await config.database.prepare(`
    DELETE FROM allowed_users
    WHERE chat_id = ?
  `).bind(normalizedId).run();

  return !!(
    result.meta &&
    Number(result.meta.changes || 0) > 0
  );
}

// 网页上传归属于 TG_ADMIN_ID 中第一个管理员
function getWebOwnerChatId(config) {
  if (
    Array.isArray(config.tgAdminId) &&
    config.tgAdminId.length > 0
  ) {
    return config.tgAdminId[0];
  }

  return '';
}
async function setWebhook(webhookUrl, botToken) {
  if (!botToken) {
    console.log('未配置Telegram机器人令牌，跳过webhook设置');
    return true;
  }
  const maxRetries = 3;
  let retryCount = 0;
  while (retryCount < maxRetries) {
    try {
      console.log(`尝试设置webhook: ${webhookUrl}`);
      const response = await fetch(
        `https://api.telegram.org/bot${botToken}/setWebhook?url=${webhookUrl}`
      );
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Telegram API错误: HTTP ${response.status} - ${errorText}`);
        retryCount++;
        continue;
      }
      const result = await response.json();
      if (!result.ok) {
        if (result.error_code === 429) {
          const retryAfter = result.parameters?.retry_after || 1;
          console.log(`请求频率限制，等待 ${retryAfter} 秒后重试...`);
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          retryCount++;
          continue;
        }
        console.error(`设置webhook失败: ${JSON.stringify(result)}`);
        return false;
      }
      console.log(`Webhook设置成功: ${webhookUrl}`);
    return true;
  } catch (error) {
      console.error(`设置webhook时出错: ${error.message}`);
      retryCount++;
      if (retryCount < maxRetries) {
        const delay = 1000 * Math.pow(2, retryCount);
        console.log(`等待 ${delay}ms 后重试...`);
        await new Promise(resolve => setTimeout(resolve, delay)); 
      }
    }
  }
  console.error('多次尝试后仍未能设置webhook');
  return false;
}
export default {
  async fetch(request, env) {
    if (!env.DATABASE) {
      console.error("缺少DATABASE配置");
      return new Response('缺少必要配置: DATABASE 环境变量未设置', { status: 500 });
    }
    const config = {
      domain: env.DOMAIN || request.headers.get("host") || '',
      database: env.DATABASE,
      username: env.USERNAME || '',
      password: env.PASSWORD || '',
      enableAuth: env.ENABLE_AUTH === 'true' || false,
      tgBotToken: env.TG_BOT_TOKEN || '',
      tgAdminId: normalizeIdList(env.TG_ADMIN_ID),
      tgStorageChatId: String(env.TG_STORAGE_CHAT_ID || '').trim(),
      cookie: Number(env.COOKIE) || 7,
      maxSizeMB: Number(env.MAX_SIZE_MB) || 20,
      bucket: env.BUCKET,
      fileCache: new Map(),
      fileCacheTTL: 3600000,
      buttonCache: new Map(),
      buttonCacheTTL: 600000,
      menuCache: new Map(),
      menuCacheTTL: 300000,
      notificationCache: '',
      notificationCacheTTL: 3600000,
      lastNotificationFetch: 0
    };
    if (config.enableAuth && (!config.username || !config.password)) {
        console.error("启用了认证但未配置用户名或密码");
        return new Response('认证配置错误: 缺少USERNAME或PASSWORD环境变量', { status: 500 });
    }
    const url = new URL(request.url);
    const { pathname } = url;
    console.log(`[Auth] Request Path: ${pathname}, Method: ${request.method}`);
    if (pathname === '/favicon.ico') {
      console.log('[Auth] Handling favicon.ico request.');
      return new Response(null, { status: 204 });
    }
    const isAuthEnabled = config.enableAuth;
    const isAuthenticated = authenticate(request, config);
    const isLoginPage = pathname === '/login';
    const isPublicApi = pathname === '/webhook' || pathname === '/config' || pathname === '/bing';
    console.log(`[Auth] isAuthEnabled: ${isAuthEnabled}, isAuthenticated: ${isAuthenticated}, isLoginPage: ${isLoginPage}, isPublicApi: ${isPublicApi}`);
    const protectedPaths = [
      '/',
      '/upload',
      '/admin',
    
      // 用户管理页面和接口
      '/users',
      '/api/users',
      '/api/users/add',
      '/api/users/delete',
    
      '/create-category',
      '/delete-category',
      '/update-suffix',
      '/delete',
      '/delete-multiple',
      '/search'
    ];
    const requiresAuth = isAuthEnabled && protectedPaths.includes(pathname);
    console.log(`[Auth] Path requires authentication: ${requiresAuth}`);
    if (requiresAuth && !isAuthenticated && !isLoginPage) {
        console.log(`[Auth] FAILED: Accessing protected path ${pathname} without authentication. Redirecting to login.`);
        if (request.method === 'POST' || request.headers.get('Accept')?.includes('application/json')) {
            return new Response(JSON.stringify({ status: 0, error: "未授权访问", redirect: `${url.origin}/login` }), {
                status: 401,
                headers: { 
                    'Content-Type': 'application/json;charset=UTF-8',
                    'Cache-Control': 'no-store'
                 }
            });
        }
        const redirectUrl = `${url.origin}/login?redirect=${encodeURIComponent(pathname + url.search)}`;
        return Response.redirect(redirectUrl, 302);
    }
    if (isAuthEnabled && isAuthenticated && isLoginPage) {
        const redirectTarget = url.searchParams.get('redirect') || '/upload';
        console.log(`[Auth] SUCCESS: Authenticated user accessing login page. Redirecting to ${redirectTarget}.`);
        return Response.redirect(`${url.origin}${redirectTarget}`, 302);
    }
    console.log(`[Auth] Check PASSED for path: ${pathname}`);
    try {
      const shouldInitDatabase =
        !isLoginPage &&
        (
          pathname === '/webhook' ||
          !isPublicApi
        );
    
      if (shouldInitDatabase) {
        await initDatabase(config);
        console.log('[DB] Database initialized successfully.');
      } else {
        console.log(
          '[DB] Skipping database initialization for public API or login page.'
        );
      }
    } catch (error) {
      console.error(`[DB] Database initialization FAILED: ${error.message}`);
      return new Response(`数据库初始化失败: ${error.message}`, { 
        status: 500,
        headers: { 
            'Content-Type': 'text/plain;charset=UTF-8',
            'Cache-Control': 'no-store'
        }
      });
    }
    if (config.tgBotToken) {
      try {
        const webhookUrl = `https://${config.domain}/webhook`;
        console.log(`[Webhook] Attempting to set webhook to: ${webhookUrl}`);
        const webhookSet = await setWebhook(webhookUrl, config.tgBotToken);
        if (!webhookSet) { 
            console.error('[Webhook] FAILED to set webhook after retries.'); 
        } else {
            console.log('[Webhook] Webhook set successfully (or already set).');
        }
      } catch (error) {
        console.error(`[Webhook] FAILED to set webhook due to error: ${error.message}`);
      }
    }
    const routes = {
      '/': async () => {
          console.log('[Route] Handling / request.');
          return handleUploadRequest(request, config);
      },
      '/login': async () => {
          console.log('[Route] Handling /login request.');
          return handleLoginRequest(request, config);
      },
      '/upload': async () => {
          console.log('[Route] Handling /upload request.');
          return handleUploadRequest(request, config);
      },
      '/admin': async () => {
          console.log('[Route] Handling /admin request.');
          return handleAdminRequest(request, config);
      },
      '/users': async () => {
        console.log('[Route] Handling /users request.');
        return handleUserManagementRequest(request, config);
      },
      
      '/api/users': async () => {
        console.log('[Route] Handling /api/users request.');
        return handleListAllowedUsersRequest(request, config);
      },
      
      '/api/users/add': async () => {
        console.log('[Route] Handling /api/users/add request.');
        return handleAddAllowedUserRequest(request, config);
      },
      
      '/api/users/delete': async () => {
        console.log('[Route] Handling /api/users/delete request.');
        return handleDeleteAllowedUserRequest(request, config);
      },
      '/delete': () => handleDeleteRequest(request, config),
      '/delete-multiple': () => handleDeleteMultipleRequest(request, config),
      '/search': () => handleSearchRequest(request, config),
      '/create-category': () => handleCreateCategoryRequest(request, config),
      '/delete-category': () => handleDeleteCategoryRequest(request, config),
      '/update-suffix': () => handleUpdateSuffixRequest(request, config),
      '/config': () => {
          console.log('[Route] Handling /config request.');
          const safeConfig = { maxSizeMB: config.maxSizeMB };
          return new Response(JSON.stringify(safeConfig), {
              headers: { 
                  'Content-Type': 'application/json',
                  'Cache-Control': 'public, max-age=3600'
               }
          });
      },
      '/webhook': () => { 
          console.log('[Route] Handling /webhook request.');
          return handleTelegramWebhook(request, config); 
      },
      '/bing': () => { 
          console.log('[Route] Handling /bing request.');
          return handleBingImagesRequest(request, config);
      }
    };
    const handler = routes[pathname];
    if (handler) {
      try {
          console.log(`[Route] Executing handler for ${pathname}`);
          const response = await handler();
          if (isAuthEnabled && requiresAuth && response.headers.get('Content-Type')?.includes('text/html')) {
              response.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
              response.headers.set('Pragma', 'no-cache');
              response.headers.set('Expires', '0');
          }
          return response;
      } catch (error) {
          console.error(`[Route] Error handling route ${pathname}:`, error);
          return new Response("服务器内部错误", { status: 500, headers: { 'Cache-Control': 'no-store' } });
      }
    }
    console.log(`[File] Handling file request for ${pathname}`);
    return await handleFileRequest(request, config);
  }
};
async function handleTelegramWebhook(request, config) {
  try {
    const update = await request.json();
    let chatId;
    let userId;
    if (update.message) {
      chatId = update.message.chat.id.toString();
      userId = update.message.from.id.toString();
      console.log(`[Webhook] Received message from chat ID: ${chatId}, User ID: ${userId}`);
      // --- Ignore group/supergroup messages --- 
      if (update.message.chat.type === 'group' || update.message.chat.type === 'supergroup') {
        console.log(`[Webhook] Ignoring message from group/supergroup chat ID: ${chatId}`);
        return new Response('OK');
      }
      // --------------------------------------
    } else if (update.callback_query) {
      chatId = update.callback_query.from.id.toString();
      userId = update.callback_query.from.id.toString();
      console.log(`[Webhook] Received callback_query from chat ID: ${chatId}, User ID: ${userId}`);
    } else {
      console.log('[Webhook] Received update without message or callback_query:', JSON.stringify(update));
      return new Response('OK');
    }
    const isAdmin = isTelegramAdmin(chatId, config);
    
    let isAllowed = false;
    
    try {
      isAllowed =
        isAdmin ||
        await isAllowedTelegramUser(chatId, config);
    } catch (error) {
      console.error(
        `[Auth Check] 查询用户授权失败: ${error.message}`
      );
    
      return new Response(
        'Authorization database error',
        { status: 500 }
      );
    }
    
    if (!isAllowed) {
      console.log(
        `[Auth Check] FAILED: Chat ID ${chatId}, ` +
        `User ID ${userId} is not authorized.`
      );
    
      if (config.tgBotToken) {
        await sendMessage(
          chatId,
          "❌ 你无权使用，请联系管理员添加你的 Telegram 用户 ID",
          config.tgBotToken
        );
      }
    
      return new Response('OK');
    }
    
    console.log(
      `[Auth Check] PASSED: Chat ID ${chatId}, ` +
      `User ID ${userId}, admin=${isAdmin}.`
    );
    let userSetting = await config.database.prepare('SELECT * FROM user_settings WHERE chat_id = ?').bind(chatId).first();
    if (!userSetting) {
      let defaultCategory = await config.database.prepare('SELECT id FROM categories WHERE name = ?').bind('默认分类').first();
      let defaultCategoryId = null;
      if (!defaultCategory) {
          try {
              console.log('默认分类不存在，为新用户创建...');
              const result = await config.database.prepare('INSERT INTO categories (name, created_at) VALUES (?, ?)')
                  .bind('默认分类', Date.now()).run();
              defaultCategoryId = result.meta && result.meta.last_row_id;
              console.log(`新默认分类创建成功，ID: ${defaultCategoryId}`);
          } catch (error) {
              console.error('为新用户创建默认分类失败:', error);
          }
      } else {
          defaultCategoryId = defaultCategory.id;
      }
      await config.database.prepare('INSERT INTO user_settings (chat_id, storage_type, current_category_id) VALUES (?, ?, ?)')
         .bind(chatId, 'telegram', defaultCategoryId).run();
      
      userSetting = { 
       chat_id: chatId, 
       storage_type: 'telegram', 
       current_category_id: defaultCategoryId 
      };
    }
    if (update.message) {
      // 管理员正在输入要添加的用户 ID
      if (
        userSetting.waiting_for === 'add_user_id' &&
        update.message.text
      ) {
        if (!isTelegramAdmin(chatId, config)) {
          await config.database.prepare(`
            UPDATE user_settings
            SET waiting_for = NULL
            WHERE chat_id = ?
          `).bind(chatId).run();
    
          userSetting.waiting_for = null;
    
          await sendMessage(
            chatId,
            "❌ 只有 TG_ADMIN_ID 管理员可以添加用户",
            config.tgBotToken
          );
    
          return new Response('OK');
        }
    
        const targetUserId = normalizeTelegramUserId(
          update.message.text
        );
    
        if (!targetUserId) {
          await sendMessage(
            chatId,
            "⚠️ 用户 ID 格式不正确。\n\n" +
            "请输入纯数字 Telegram 用户 ID，例如：123456789",
            config.tgBotToken
          );
    
          // 不清除等待状态，管理员可以重新输入
          return new Response('OK');
        }
    
        try {
          const result = await addAllowedTelegramUser(
            targetUserId,
            chatId,
            config
          );
    
          await config.database.prepare(`
            UPDATE user_settings
            SET waiting_for = NULL
            WHERE chat_id = ?
          `).bind(chatId).run();
    
          userSetting.waiting_for = null;
    
          if (result.alreadyAdmin) {
            await sendMessage(
              chatId,
              `ℹ️ 用户 ${targetUserId} 已经是 TG_ADMIN_ID 管理员，无需重复添加`,
              config.tgBotToken
            );
          } else if (!result.created) {
            await sendMessage(
              chatId,
              `ℹ️ 用户 ${targetUserId} 已经在授权列表中`,
              config.tgBotToken
            );
          } else {
            await sendMessage(
              chatId,
              `✅ 已添加授权用户：${targetUserId}`,
              config.tgBotToken
            );
          }
        } catch (error) {
          console.error('添加授权用户失败:', error);
    
          await sendMessage(
            chatId,
            `❌ 添加用户失败：${error.message}`,
            config.tgBotToken
          );
        }
    
        await sendPanel(chatId, userSetting, config);
        return new Response('OK');
      }
    
      else if (
        userSetting.waiting_for === 'new_category' &&
        update.message.text
      ) {
        const categoryName = update.message.text.trim();
        try {
          const existingCategory = await config.database.prepare('SELECT id FROM categories WHERE name = ?').bind(categoryName).first();
          if (existingCategory) {
            await sendMessage(chatId, `⚠️ 分类"${categoryName}"已存在`, config.tgBotToken);
          } else {
            const time = Date.now();
            await config.database.prepare('INSERT INTO categories (name, created_at) VALUES (?, ?)').bind(categoryName, time).run();
            const newCategory = await config.database.prepare('SELECT id FROM categories WHERE name = ?').bind(categoryName).first();
            await config.database.prepare('UPDATE user_settings SET current_category_id = ?, waiting_for = NULL WHERE chat_id = ?').bind(newCategory.id, chatId).run();
            await sendMessage(chatId, `✅ 分类"${categoryName}"创建成功并已设为当前分类`, config.tgBotToken);
          }
  } catch (error) {
          console.error('创建分类失败:', error);
          await sendMessage(chatId, `❌ 创建分类失败: ${error.message}`, config.tgBotToken);
        }
        await config.database.prepare('UPDATE user_settings SET waiting_for = NULL WHERE chat_id = ?').bind(chatId).run();
        userSetting.waiting_for = null;
        if (categoryName) {
          const newCategory = await config.database.prepare('SELECT id FROM categories WHERE name = ?').bind(categoryName).first();
          if (newCategory) {
            userSetting.current_category_id = newCategory.id;
          }
        }
        await sendPanel(chatId, userSetting, config);
        return new Response('OK');
      }
      else if (userSetting.waiting_for === 'new_suffix' && update.message.text && userSetting.editing_file_id) {
        const newSuffix = update.message.text.trim();
        const fileId = userSetting.editing_file_id;
        try {
          const file = await config.database.prepare('SELECT * FROM files WHERE id = ?').bind(fileId).first();
          if (!file) {
            await sendMessage(chatId, "⚠️ 文件不存在或已被删除", config.tgBotToken);
          } else {
            const originalFileName = getFileName(file.url);
            const fileExt = originalFileName.split('.').pop();
            const newFileName = `${newSuffix}.${fileExt}`;
            const fileUrl = `https://${config.domain}/${newFileName}`;
            let success = false;
            if (file.storage_type === 'telegram') {
              await config.database.prepare('UPDATE files SET url = ? WHERE id = ?')
                .bind(fileUrl, file.id).run();
              success = true;
            } 
            else if (file.storage_type === 'r2' && config.bucket) {
              try {
                const fileId = file.fileId || originalFileName;
                const r2File = await config.bucket.get(fileId);
                if (r2File) {
                  const fileData = await r2File.arrayBuffer();
                  await storeFile(fileData, newFileName, r2File.httpMetadata.contentType, config);
                  await deleteFile(fileId, config);
                  await config.database.prepare('UPDATE files SET fileId = ?, url = ? WHERE id = ?')
                    .bind(newFileName, fileUrl, file.id).run();
                  success = true;
                } else {
                  await config.database.prepare('UPDATE files SET url = ? WHERE id = ?')
                    .bind(fileUrl, file.id).run();
                  success = true;
                }
              } catch (error) {
                console.error('处理R2文件重命名失败:', error);
                await config.database.prepare('UPDATE files SET url = ? WHERE id = ?')
                  .bind(fileUrl, file.id).run();
                success = true;
              }
            } 
            else {
              await config.database.prepare('UPDATE files SET url = ? WHERE id = ?')
                .bind(fileUrl, file.id).run();
              success = true;
            }
            if (success) {
              await sendMessage(chatId, `✅ 后缀修改成功！\n\n新链接：${fileUrl}`, config.tgBotToken);
            } else {
              await sendMessage(chatId, "❌ 后缀修改失败，请稍后重试", config.tgBotToken);
            }
          }
        } catch (error) {
          console.error('修改后缀失败:', error);
          await sendMessage(chatId, `❌ 修改后缀失败: ${error.message}`, config.tgBotToken);
        }
        await config.database.prepare('UPDATE user_settings SET waiting_for = NULL, editing_file_id = NULL WHERE chat_id = ?').bind(chatId).run();
        userSetting.waiting_for = null;
        userSetting.editing_file_id = null;
        await sendPanel(chatId, userSetting, config);
        return new Response('OK');
      }
      else if (userSetting.waiting_for === 'delete_file_input' && update.message.text) {
        try {
          await config.database.prepare('UPDATE user_settings SET waiting_for = NULL WHERE chat_id = ?')
            .bind(chatId).run();
          userSetting.waiting_for = null;
          const userInput = update.message.text;
          let fileToDelete = await findFileRecord(userInput, chatId, config);
          if (!fileToDelete) {
            await sendMessage(chatId, "⚠️ 未找到匹配的文件，请输入完整的文件名称或URL", config.tgBotToken);
            await sendPanel(chatId, userSetting, config);
            return new Response('OK');
          }
          const fileName = fileToDelete.file_name || getFileName(fileToDelete.url);
          console.log(`[TG Delete] 找到匹配文件: ID=${fileToDelete.id}, 名称=${fileName}, URL=${fileToDelete.url}`);
          console.log(`[TG Delete] 开始删除: ID=${fileToDelete.id}, 类型=${fileToDelete.storage_type}, TGMsgID=${fileToDelete.message_id}, R2ID=${fileToDelete.fileId}`);
          let storageDeleteSuccess = false;
          if (fileToDelete.storage_type === 'r2' && config.bucket && fileToDelete.fileId) {
            try {
              await config.bucket.delete(fileToDelete.fileId);
              console.log(`[TG Delete] R2文件已删除: ${fileToDelete.fileId}`);
              storageDeleteSuccess = true;
            } catch (r2Error) {
              console.error(`[TG Delete] 从R2删除失败: ${r2Error.message}`);
            }
          } else if (fileToDelete.storage_type === 'telegram' && fileToDelete.message_id && fileToDelete.message_id !== -1 && fileToDelete.message_id !== 0) {
            try {
              const deleteTgMsgResponse = await fetch(
                `https://api.telegram.org/bot${config.tgBotToken}/deleteMessage?chat_id=${config.tgStorageChatId}&message_id=${fileToDelete.message_id}`
              );
              const deleteTgMsgResult = await deleteTgMsgResponse.json();
              if (deleteTgMsgResponse.ok && deleteTgMsgResult.ok) {
                console.log(`[TG Delete] Telegram消息已删除: ${fileToDelete.message_id}`);
                storageDeleteSuccess = true;
              } else {
                console.warn(`[TG Delete] 删除Telegram消息失败 ${fileToDelete.message_id}: ${JSON.stringify(deleteTgMsgResult)}`);
              }
            } catch (tgError) {
              console.error(`[TG Delete] 删除Telegram消息错误: ${tgError.message}`);
            }
          } else {
            console.log(`[TG Delete] ID ${fileToDelete.id} 没有关联的存储文件/消息需要删除 (类型: ${fileToDelete.storage_type}, TGMsgID: ${fileToDelete.message_id}, R2ID: ${fileToDelete.fileId})`);
            storageDeleteSuccess = true;
          }
          await config.database.prepare('DELETE FROM files WHERE id = ?').bind(fileToDelete.id).run();
          console.log(`[TG Delete] 数据库记录已删除: ID=${fileToDelete.id}`);
          const cacheKey = `file:${fileName}`;
          if (config.fileCache && config.fileCache.has(cacheKey)) {
            config.fileCache.delete(cacheKey);
            console.log(`[TG Delete] 文件缓存已清除: ${cacheKey}`);
          }
          await sendMessage(chatId, `✅ 文件已成功删除: ${fileName}`, config.tgBotToken);
          await sendPanel(chatId, userSetting, config);
          return new Response('OK');
        } catch (error) {
          console.error(`[TG Delete] 删除过程中出错:`, error);
          await sendMessage(chatId, `❌ 删除文件时出错: ${error.message}`, config.tgBotToken);
          await sendPanel(chatId, userSetting, config);
          return new Response('OK');
        }
      }
      if (update.message.text === '/start') {
        await sendPanel(chatId, userSetting, config);
      }
      else if (update.message.photo || update.message.document || update.message.video || update.message.audio || update.message.voice || update.message.video_note) {
        console.log('收到文件上传:', JSON.stringify({
          hasPhoto: !!update.message.photo,
          hasDocument: !!update.message.document,
          hasVideo: !!update.message.video,
          hasAudio: !!update.message.audio,
          hasVoice: !!update.message.voice,
          hasVideoNote: !!update.message.video_note
        }));
        let file;
        let isDocument = false;
        if (update.message.document) {
          file = update.message.document;
          isDocument = true;
        } else if (update.message.video) {
          file = update.message.video;
          isDocument = true;
        } else if (update.message.audio) {
          file = update.message.audio;
          isDocument = true;
        } else if (update.message.voice) {
          file = update.message.voice;
          isDocument = true;
        } else if (update.message.video_note) {
          file = update.message.video_note;
          isDocument = true;
        } else if (update.message.photo) {
          file = update.message.photo && update.message.photo.length ? update.message.photo[update.message.photo.length - 1] : null;
          isDocument = false;
        }
        if (file) {
          const gotLock = await acquireUploadLock(chatId, config);
          if (!gotLock) {
            await sendMessage(chatId, "⏳ 有其他文件正在处理中，请稍后重试或稍等片刻", config.tgBotToken);
            return new Response('OK');
          }
          try {
            await handleMediaUpload(chatId, file, isDocument, config, userSetting);
          } finally {
            await releaseUploadLock(chatId, config); // 无论成功失败都要释放锁，避免后续文件永远卡住
          }
        } else {
          await sendMessage(chatId, "❌ 无法识别的文件类型", config.tgBotToken);
        }
      }
      else {
        const message = update.message;
        let fileField = null;
        for (const field in message) {
          if (message[field] && typeof message[field] === 'object' && message[field].file_id) {
            fileField = field;
            break;
          }
        }
        if (fileField) {
          console.log(`找到未明确处理的文件类型: ${fileField}`, JSON.stringify(message[fileField]));
          const gotLock = await acquireUploadLock(chatId, config);
          if (!gotLock) {
            await sendMessage(chatId, "⏳ 有其他文件正在处理中，请稍后重试", config.tgBotToken);
            return new Response('OK');
          }
          try {
            await handleMediaUpload(chatId, message[fileField], true, config, userSetting);
          } finally {
            await releaseUploadLock(chatId, config);
          }
        } else if (userSetting.waiting_for === 'edit_suffix_input_file' && message.text) {
          try {
            const userInput = message.text.trim();
            let fileToEdit = null;
            if (userInput.startsWith('http://') || userInput.startsWith('https://')) {
              fileToEdit = await config.database.prepare(
                'SELECT id, url, file_name FROM files WHERE url = ? AND chat_id = ?'
              ).bind(userInput, chatId).first();
            } else {
              let fileName = userInput;
              if (!fileName.includes('.')) {
                await sendMessage(chatId, "⚠️ 请输入完整的文件名称（包含扩展名）或完整URL", config.tgBotToken);
                await config.database.prepare('UPDATE user_settings SET waiting_for = NULL, editing_file_id = NULL WHERE chat_id = ?')
                  .bind(chatId).run();
                userSetting.waiting_for = null;
                userSetting.editing_file_id = null;
                await sendPanel(chatId, userSetting, config);
                return new Response('OK');
              }
              fileToEdit = await config.database.prepare(
                'SELECT id, url, file_name FROM files WHERE (file_name = ? OR url LIKE ?) AND chat_id = ? ORDER BY created_at DESC LIMIT 1'
              ).bind(fileName, `%/${fileName}`, chatId).first();
            }
            if (!fileToEdit) {
              await sendMessage(chatId, "⚠️ 未找到匹配的文件，请输入完整的文件名称或URL", config.tgBotToken);
              await config.database.prepare('UPDATE user_settings SET waiting_for = NULL, editing_file_id = NULL WHERE chat_id = ?')
                .bind(chatId).run();
              userSetting.waiting_for = null;
              userSetting.editing_file_id = null;
              await sendPanel(chatId, userSetting, config);
              return new Response('OK');
            }
            const fileName = fileToEdit.file_name || getFileName(fileToEdit.url);
            const fileNameParts = fileName.split('.');
            const extension = fileNameParts.pop();
            const currentSuffix = fileNameParts.join('.');
            await config.database.prepare('UPDATE user_settings SET waiting_for = ?, editing_file_id = ? WHERE chat_id = ?')
              .bind('edit_suffix_input_new', fileToEdit.id, chatId).run();
            userSetting.waiting_for = 'edit_suffix_input_new';
            userSetting.editing_file_id = fileToEdit.id;
            await sendMessage(
              chatId,
              `📝 找到文件: ${fileName}\n当前后缀: ${currentSuffix}\n\n请回复此消息，输入文件的新后缀（不含扩展名）`,
              config.tgBotToken
            );
            return new Response('OK');
          } catch (error) {
            console.error('处理修改后缀文件选择失败:', error);
            await sendMessage(chatId, `❌ 处理失败: ${error.message}`, config.tgBotToken);
            await config.database.prepare('UPDATE user_settings SET waiting_for = NULL, editing_file_id = NULL WHERE chat_id = ?')
              .bind(chatId).run();
            userSetting.waiting_for = null;
            userSetting.editing_file_id = null;
            await sendPanel(chatId, userSetting, config);
            return new Response('OK');
          }
        } else if (userSetting.waiting_for === 'edit_suffix_input_new' && message.text && userSetting.editing_file_id) {
          const newSuffix = message.text.trim();
          const fileId = userSetting.editing_file_id;
          try {
            const file = await config.database.prepare('SELECT * FROM files WHERE id = ?').bind(fileId).first();
            if (!file) {
              await sendMessage(chatId, "⚠️ 文件不存在或已被删除", config.tgBotToken);
            } else {
              const originalFileName = getFileName(file.url);
              const fileExt = originalFileName.split('.').pop();
              const newFileName = `${newSuffix}.${fileExt}`;
              const fileUrl = `https://${config.domain}/${newFileName}`;
              let success = false;
              if (file.storage_type === 'telegram') {
                await config.database.prepare('UPDATE files SET url = ? WHERE id = ?')
                  .bind(fileUrl, file.id).run();
                success = true;
              } 
              else if (file.storage_type === 'r2' && config.bucket) {
                try {
                  const fileId = file.fileId || originalFileName;
                  const r2File = await config.bucket.get(fileId);
                  if (r2File) {
                    const fileData = await r2File.arrayBuffer();
                    await storeFile(fileData, newFileName, r2File.httpMetadata.contentType, config);
                    await deleteFile(fileId, config);
                    await config.database.prepare('UPDATE files SET fileId = ?, url = ? WHERE id = ?')
                      .bind(newFileName, fileUrl, file.id).run();
                    success = true;
                  } else {
                    await config.database.prepare('UPDATE files SET url = ? WHERE id = ?')
                      .bind(fileUrl, file.id).run();
                    success = true;
                  }
                } catch (error) {
                  console.error('处理R2文件重命名失败:', error);
                  await config.database.prepare('UPDATE files SET url = ? WHERE id = ?')
                    .bind(fileUrl, file.id).run();
                  success = true;
                }
              } 
              else {
                await config.database.prepare('UPDATE files SET url = ? WHERE id = ?')
                  .bind(fileUrl, file.id).run();
                success = true;
              }
              if (success) {
                await sendMessage(chatId, `✅ 后缀修改成功！\n\n新链接：${fileUrl}`, config.tgBotToken);
              } else {
                await sendMessage(chatId, "❌ 后缀修改失败，请稍后重试", config.tgBotToken);
              }
            }
          } catch (error) {
            console.error('修改后缀失败:', error);
            await sendMessage(chatId, `❌ 修改后缀失败: ${error.message}`, config.tgBotToken);
          }
          await config.database.prepare('UPDATE user_settings SET waiting_for = NULL, editing_file_id = NULL WHERE chat_id = ?').bind(chatId).run();
          userSetting.waiting_for = null;
          userSetting.editing_file_id = null;
          await sendPanel(chatId, userSetting, config);
          return new Response('OK');
        } else if (message.text && message.text !== '/start') {
          await sendMessage(chatId, "请发送图片或文件进行上传，或使用 /start 查看主菜单", config.tgBotToken);
        }
      }
    }
    else if (update.callback_query) {
      await handleCallbackQuery(update, config, userSetting);
    }
    return new Response('OK');
  } catch (error) {
    console.error('Error handling webhook:', error);
    return new Response('Error processing webhook', { status: 500 });
  }
}
async function sendPanel(chatId, userSetting, config) {
  try {
    const menuRole = isTelegramAdmin(chatId, config)
      ? 'admin'
      : 'user';
    
    const cacheKey =
      `menu:${chatId}:` +
      `${userSetting.storage_type || 'default'}:` +
      `${menuRole}`;
    if (config.menuCache && config.menuCache.has(cacheKey)) {
      const cachedData = config.menuCache.get(cacheKey);
      if (Date.now() - cachedData.timestamp < config.menuCacheTTL) {
        console.log(`使用缓存的菜单: ${cacheKey}`);
        const response = await fetch(`https://api.telegram.org/bot${config.tgBotToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: cachedData.menuData
        });
        if (!response.ok) {
          config.menuCache.delete(cacheKey);
          console.log(`缓存菜单发送失败，重新生成: ${await response.text()}`);
        } else {
          return await response.json();
        }
      } else {
        config.menuCache.delete(cacheKey);
      }
    }
    const { messageBody, keyboard } = await generateMainMenu(chatId, userSetting, config);
    const menuData = JSON.stringify({
      chat_id: chatId,
      text: messageBody,
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
    if (config.menuCache) {
      config.menuCache.set(cacheKey, {
        menuData,
        timestamp: Date.now()
      });
    }
    const response = await fetch(`https://api.telegram.org/bot${config.tgBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: menuData
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`发送面板失败: ${errorText}`);
      return null;
    }
    return await response.json();
  } catch (error) {
    console.error('发送面板出错:', error);
    return null;
  }
}
async function generateMainMenu(chatId, userSetting, config) {
  const storageText = userSetting.storage_type === 'r2' ? 'R2对象存储' : 'Telegram存储';
  let categoryName = '未选择分类';
  const categoryPromise = userSetting.current_category_id ? 
      config.database.prepare('SELECT name FROM categories WHERE id = ?')
        .bind(userSetting.current_category_id).first() 
      : Promise.resolve(null);
  const statsPromise = config.database.prepare(`
    SELECT COUNT(*) as total_files, SUM(file_size) as total_size
    FROM files WHERE chat_id = ?
  `).bind(chatId).first();
  const notificationPromise = (async () => {
    const now = Date.now();
    if (!config.notificationCache || (now - config.lastNotificationFetch > config.notificationCacheTTL)) {
      try {
        console.log('[Notification] Fetching new notification...');
        config.notificationCache = await fetchNotification();
        config.lastNotificationFetch = now;
      } catch (error) {
        console.error('[Notification] Failed to fetch notification:', error);
        config.notificationCache = config.notificationCache || ''; 
      }
    }
    return config.notificationCache;
  })();
  const [categoryResult, stats, notificationText] = await Promise.all([
    categoryPromise,
    statsPromise,
    notificationPromise
  ]);
  if (categoryResult) {
    categoryName = categoryResult.name;
  }
  const defaultNotification = 
    "➡️ 现在您可以直接发送图片或文件，上传完成后会自动生成图床直链\n" +
    "➡️ 所有上传的文件都可以在网页后台管理，支持删除、查看、分类等操作";
  const messageBody = `☁️ <b>图床助手v1</b>
  📂 当前存储：${storageText}
  📁 当前分类：${categoryName}
  📊 已上传：${stats && stats.total_files ? stats.total_files : 0} 个文件
  💾 已用空间：${formatSize(stats && stats.total_size ? stats.total_size : 0)}
  ${notificationText || defaultNotification}
  👇 请选择操作：`;
  const keyboard = getKeyboardLayout(
    userSetting,
    isTelegramAdmin(chatId, config)
  );
  return { messageBody, keyboard };
}
function getKeyboardLayout(userSetting, isAdmin = false) {
  const rows = [
    [
      {
        text: "📋 选择分类",
        callback_data: "list_categories"
      }
    ]
  ];

  // 仅管理员显示用户管理按钮
  if (isAdmin) {
    rows.push([
      {
        text: "📤 切换存储",
        callback_data: "switch_storage"
      },
      {
        text: "📊 R2统计",
        callback_data: "r2_stats"
      },
      {
        text: "📝 创建分类",
        callback_data: "create_category"
      },
    ],
    [
      {
        text: "➕ 添加用户",
        callback_data: "add_user"
      },
      {
        text: "➖ 删除用户",
        callback_data: "delete_user"
      }
    ]);
  }

  rows.push(
    [
      {
        text: "📂 最近文件",
        callback_data: "recent_files"
      },
      {
        text: "✏️ 修改后缀",
        callback_data: "edit_suffix_input"
      },
      {
        text: "🗑️ 删除文件",
        callback_data: "delete_file_input"
      }
    ],
    [
      {
        text: "📦 联系我们",
        url: "https://t.me/unmihari1"
      }
    ]
  );

  return {
    inline_keyboard: rows
  };
}
// 生成简洁的存储 key，避免用杂乱原始文件名拼URL
function generateSafeKey(originalName) {
  let ext = 'bin';
  if (originalName && originalName.includes('.')) {
    const rawExt = originalName.split('.').pop();
    const cleanExt = rawExt.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    if (cleanExt) ext = cleanExt;
  }
  const randomPart = Math.random().toString(36).slice(2, 8); // 6位随机字符
  return `${Date.now()}_${randomPart}.${ext}`;
}

// 去除零宽字符/首尾空白，防止复制粘贴带入不可见字符导致匹配失败
function normalizeInput(str) {
  return (str || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}

// 从URL或文本中提取路径最后一段（文件名部分）
function extractKeyFromInput(input) {
  try {
    if (input.startsWith('http://') || input.startsWith('https://')) {
      const u = new URL(input);
      return decodeURIComponent(u.pathname.split('/').pop());
    }
  } catch (e) {}
  return input.split('/').pop();
}

// 综合查找：精确URL -> http/https互换 -> basename(fileId/url片段) -> 原始文件名
async function findFileRecord(rawInput, chatId, config) {
  const input = normalizeInput(rawInput);
  if (!input) return null;
  const isUrl = input.startsWith('http://') || input.startsWith('https://');
  const basename = extractKeyFromInput(input);

  if (isUrl) {
    let rec = await config.database.prepare(
      'SELECT id, fileId, message_id, storage_type, url, file_name FROM files WHERE url = ? AND (chat_id = ? OR chat_id IS NULL)'
    ).bind(input, chatId).first();
    if (rec) return rec;

    const altUrl = input.startsWith('https://')
      ? 'http://' + input.slice('https://'.length)
      : 'https://' + input.slice('http://'.length);
    rec = await config.database.prepare(
      'SELECT id, fileId, message_id, storage_type, url, file_name FROM files WHERE url = ? AND (chat_id = ? OR chat_id IS NULL)'
    ).bind(altUrl, chatId).first();
    if (rec) return rec;
  }

  if (basename) {
    let rec = await config.database.prepare(
      'SELECT id, fileId, message_id, storage_type, url, file_name FROM files WHERE (fileId = ? OR url LIKE ?) AND (chat_id = ? OR chat_id IS NULL) ORDER BY created_at DESC LIMIT 1'
    ).bind(basename, `%/${basename}`, chatId).first();
    if (rec) return rec;
  }

  if (!isUrl) {
    let rec = await config.database.prepare(
      'SELECT id, fileId, message_id, storage_type, url, file_name FROM files WHERE (file_name = ? OR url LIKE ?) AND (chat_id = ? OR chat_id IS NULL) ORDER BY created_at DESC LIMIT 1'
    ).bind(input, `%/${input}`, chatId).first();
    if (rec) return rec;
  }

  return null;
}
async function handleCallbackQuery(update, config, userSetting) {
  const chatId = update.callback_query.from.id.toString();
  const cbData = update.callback_query.data;
  const answerPromise = fetch(`https://api.telegram.org/bot${config.tgBotToken}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: update.callback_query.id })
  }).catch(error => {
    console.error('确认回调查询失败:', error);
  });
  try {
    if (
      userSetting.waiting_for &&
      !cbData.startsWith('delete_file_do_')
    ) {
      if (
        !(
          userSetting.waiting_for === 'new_suffix' &&
          cbData.startsWith('edit_suffix_file_')
        ) &&
        !(
          userSetting.waiting_for === 'new_category' &&
          cbData === 'create_category'
        ) &&
        !(
          userSetting.waiting_for === 'add_user_id' &&
          cbData === 'add_user'
        ) &&
        !(
          userSetting.waiting_for === 'delete_file_input' &&
          cbData === 'delete_file_input'
        ) &&
        !(
          userSetting.waiting_for === 'edit_suffix_input_file' &&
          cbData === 'edit_suffix_input'
        ) &&
        !(
          userSetting.waiting_for === 'edit_suffix_input_new' &&
          userSetting.editing_file_id
        )
      ) {
        await config.database.prepare(`
          UPDATE user_settings
          SET waiting_for = NULL,
              editing_file_id = NULL
          WHERE chat_id = ?
        `).bind(chatId).run();
    
        userSetting.waiting_for = null;
        userSetting.editing_file_id = null;
      }
    }
    const cacheKey = `button:${chatId}:${cbData}`;
    const isUserManagementCallback =
      cbData === 'add_user' ||
      cbData === 'delete_user' ||
      cbData.startsWith('remove_user_');
    if (
      config.buttonCache &&
      config.buttonCache.has(cacheKey) &&
      !isUserManagementCallback &&
      !cbData.startsWith('delete_file_confirm_') &&
      !cbData.startsWith('delete_file_do_')
    ) {
      const cachedData = config.buttonCache.get(cacheKey);
      if (Date.now() - cachedData.timestamp < config.buttonCacheTTL) {
        console.log(`使用缓存的按钮响应: ${cacheKey}`);
        await answerPromise;
        if (cachedData.responseText) {
          await sendMessage(chatId, cachedData.responseText, config.tgBotToken);
        }
        if (cachedData.sendPanel) {
          await sendPanel(chatId, userSetting, config);
        }
        if (cachedData.replyMarkup) {
          await fetch(`https://api.telegram.org/bot${config.tgBotToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: cachedData.replyText,
              reply_markup: cachedData.replyMarkup,
              parse_mode: 'HTML',
              disable_web_page_preview: cachedData.disablePreview || false
            })
          });
        }
        return;
      } else {
        config.buttonCache.delete(cacheKey);
      }
    }
    if (cbData === 'switch_storage') {
      // 管理员权限验证
      if (
        config.tgAdminId &&
        config.tgAdminId.length > 0 &&
        !config.tgAdminId.includes(chatId)
      ) {
        await answerPromise;
    
        await sendMessage(
          chatId,
          "❌ 你没有权限切换存储模式",
          config.tgBotToken
        );
    
        return;
      }
    
      const newStorageType =
        userSetting.storage_type === 'telegram'
          ? 'r2'
          : 'telegram';
    
      await Promise.all([
        config.database.prepare(
          'UPDATE user_settings SET storage_type = ? WHERE chat_id = ?'
        )
        .bind(newStorageType, chatId)
        .run(),
    
        answerPromise
      ]);
    
      if (config.buttonCache) {
        config.buttonCache.set(cacheKey, {
          timestamp: Date.now(),
          sendPanel: true
        });
      }
    
      await sendMessage(
        chatId,
        `✅ 已切换存储模式：${newStorageType === 'r2' ? 'R2对象存储' : 'Telegram存储'}`,
        config.tgBotToken
      );
    
      await sendPanel(
        chatId,
        { ...userSetting, storage_type: newStorageType },
        config
      );
    }
    else if (cbData === 'add_user') {
      if (!isTelegramAdmin(chatId, config)) {
        await answerPromise;
    
        await sendMessage(
          chatId,
          "❌ 只有 TG_ADMIN_ID 管理员可以添加用户",
          config.tgBotToken
        );
    
        return;
      }
    
      await Promise.all([
        answerPromise,
    
        config.database.prepare(`
          UPDATE user_settings
          SET waiting_for = ?,
              editing_file_id = NULL
          WHERE chat_id = ?
        `).bind(
          'add_user_id',
          chatId
        ).run()
      ]);
    
      userSetting.waiting_for = 'add_user_id';
      userSetting.editing_file_id = null;
    
      await sendMessage(
        chatId,
        "➕ 请回复此消息，输入需要授权的 Telegram 用户 ID。\n\n" +
        "只输入纯数字，例如：123456789",
        config.tgBotToken
      );
    }
    else if (cbData === 'delete_user') {
      if (!isTelegramAdmin(chatId, config)) {
        await answerPromise;
    
        await sendMessage(
          chatId,
          "❌ 只有 TG_ADMIN_ID 管理员可以删除用户",
          config.tgBotToken
        );
    
        return;
      }
    
      const users = await listAllowedTelegramUsers(config);
    
      await answerPromise;
    
      if (!users.length) {
        await sendMessage(
          chatId,
          "ℹ️ 当前没有普通授权用户",
          config.tgBotToken
        );
    
        return;
      }
    
      const userButtons = users.map(user => {
        return [
          {
            text: `🗑️ ${user.chat_id}`,
            callback_data: `remove_user_${user.chat_id}`
          }
        ];
      });
    
      userButtons.push([
        {
          text: "« 返回",
          callback_data: "back_to_panel"
        }
      ]);
    
      await fetch(
        `https://api.telegram.org/bot${config.tgBotToken}/sendMessage`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            chat_id: chatId,
            text:
              "➖ 请选择要取消授权的用户：\n\n" +
              "删除授权不会删除该用户已经上传的文件。",
            reply_markup: {
              inline_keyboard: userButtons
            }
          })
        }
      );
    }
    else if (cbData.startsWith('remove_user_')) {
      if (!isTelegramAdmin(chatId, config)) {
        await answerPromise;
    
        await sendMessage(
          chatId,
          "❌ 只有 TG_ADMIN_ID 管理员可以删除用户",
          config.tgBotToken
        );
    
        return;
      }
    
      const targetUserId = normalizeTelegramUserId(
        cbData.slice('remove_user_'.length)
      );
    
      await answerPromise;
    
      if (!targetUserId) {
        await sendMessage(
          chatId,
          "❌ 无效的 Telegram 用户 ID",
          config.tgBotToken
        );
    
        return;
      }
    
      try {
        const removed = await removeAllowedTelegramUser(
          targetUserId,
          config
        );
    
        if (removed) {
          await sendMessage(
            chatId,
            `✅ 已取消用户 ${targetUserId} 的使用权限`,
            config.tgBotToken
          );
        } else {
          await sendMessage(
            chatId,
            `ℹ️ 用户 ${targetUserId} 已不在授权列表中`,
            config.tgBotToken
          );
        }
      } catch (error) {
        console.error('删除授权用户失败:', error);
    
        await sendMessage(
          chatId,
          `❌ 删除用户失败：${error.message}`,
          config.tgBotToken
        );
      }
    
      await sendPanel(chatId, userSetting, config);
    }
    else if (cbData === 'list_categories') {
      const categoriesPromise = config.database.prepare('SELECT id, name FROM categories').all();
      await answerPromise;
      const categories = await categoriesPromise;
      if (!categories.results || categories.results.length === 0) {
        await sendMessage(chatId, "⚠️ 暂无分类，请先创建分类", config.tgBotToken);
        return;
      }
      const categoriesText = categories.results.map((cat, i) =>
        `${i + 1}. ${cat.name}`
      ).join('\n');
      const keyboard = {
        inline_keyboard: categories.results.map(cat => [
          { text: cat.name, callback_data: `set_category_${cat.id}` }
        ]).concat([[{ text: "« 返回", callback_data: "back_to_panel" }]])
      };
      if (config.buttonCache) {
        config.buttonCache.set(cacheKey, {
          timestamp: Date.now(),
          replyText: "📂 请选择要使用的分类：\n\n" + categoriesText,
          replyMarkup: keyboard
        });
      }
      await fetch(`https://api.telegram.org/bot${config.tgBotToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: "📂 请选择要使用的分类：\n\n" + categoriesText,
          reply_markup: keyboard
        })
      });
    }
    else if (cbData === 'create_category') {
      // 管理员权限验证
      if (
        config.tgAdminId &&
        config.tgAdminId.length > 0 &&
        !config.tgAdminId.includes(chatId)
      ) {
        await answerPromise;
    
        await sendMessage(
          chatId,
          "❌ 你没有权限创建分类，请联系管理员",
          config.tgBotToken
        );
    
        return;
      }
      if (config.buttonCache) {
        config.buttonCache.set(cacheKey, {
          timestamp: Date.now(),
          responseText: "📝 请回复此消息，输入新分类名称"
        });
      }
      await Promise.all([
        answerPromise,
        sendMessage(chatId, "📝 请回复此消息，输入新分类名称", config.tgBotToken),
        config.database.prepare(
          'UPDATE user_settings SET waiting_for = ? WHERE chat_id = ?'
        )
          .bind('new_category', chatId)
          .run()
      ]);
    
      userSetting.waiting_for = 'new_category';
    }
    else if (cbData.startsWith('set_category_')) {
      const categoryId = parseInt(cbData.split('_')[2]);
      const updatePromise = config.database.prepare(
        'UPDATE user_settings SET current_category_id = ? WHERE chat_id = ?'
      ).bind(categoryId, chatId).run();
      const categoryPromise = config.database.prepare(
        'SELECT name FROM categories WHERE id = ?'
      ).bind(categoryId).first();
      await answerPromise;
      const [_, category] = await Promise.all([updatePromise, categoryPromise]);
      const responseText = `✅ 已切换到分类: ${category?.name || '未知分类'}`;
      if (config.buttonCache) {
        config.buttonCache.set(`button:${chatId}:${cbData}`, {
          timestamp: Date.now(),
          responseText,
          sendPanel: true
        });
      }
      await sendMessage(chatId, responseText, config.tgBotToken);
      await sendPanel(chatId, { ...userSetting, current_category_id: categoryId }, config);
    }
    else if (cbData === 'back_to_panel') {
      if (config.buttonCache) {
        config.buttonCache.set(cacheKey, {
          timestamp: Date.now(),
          sendPanel: true
        });
      }
      await answerPromise;
      if (userSetting.waiting_for) {
        await config.database.prepare('UPDATE user_settings SET waiting_for = NULL, editing_file_id = NULL WHERE chat_id = ?').bind(chatId).run();
        userSetting.waiting_for = null;
        userSetting.editing_file_id = null;
      }
      await sendPanel(chatId, userSetting, config);
    }
    if (cbData === 'r2_stats') {
      // 管理员权限验证
      if (
        config.tgAdminId &&
        config.tgAdminId.length > 0 &&
        !config.tgAdminId.includes(chatId)
      ) {
        await answerPromise;
        await sendMessage(
          chatId,
          "❌ 你没有权限查看 R2 统计，请联系管理员",
          config.tgBotToken
        );
        return;
      }
      await answerPromise;
      const stats = await statsPromise;
      const statsMessage = `📊 您的 R2 存储使用统计
  ─────────────
  📁 R2 文件数: ${stats.total_files || 0}
  💾 R2 存储量: ${formatSize(stats.total_size || 0)}`;
      if (config.buttonCache) {
        config.buttonCache.set(cacheKey, {
          timestamp: Date.now(),
          responseText: statsMessage
        });
      }
      await sendMessage(chatId, statsMessage, config.tgBotToken);
    }
    else if (cbData === 'edit_suffix') {
      await answerPromise;
      const recentFiles = await config.database.prepare(`
        SELECT id, url, fileId, file_name, created_at, storage_type
        FROM files
        WHERE chat_id = ?
        ORDER BY created_at DESC
        LIMIT 5
      `).bind(chatId).all();
      if (!recentFiles.results || recentFiles.results.length === 0) {
        await sendMessage(chatId, "⚠️ 您还没有上传过文件", config.tgBotToken);
        return;
      }
      const keyboard = {
        inline_keyboard: recentFiles.results.map(file => {
          const fileName = file.file_name || getFileName(file.url);
          return [{ text: fileName, callback_data: `edit_suffix_file_${file.id}` }];
        }).concat([[{ text: "« 返回", callback_data: "back_to_panel" }]])
      };
      await fetch(`https://api.telegram.org/bot${config.tgBotToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: "📝 请选择要修改后缀的文件：",
          reply_markup: keyboard
        })
      });
    }
    else if (cbData === 'recent_files') {
      const recentFilesPromise = config.database.prepare(`
        SELECT id, url, created_at, file_name, storage_type
        FROM files
        WHERE chat_id = ?
        ORDER BY created_at DESC
        LIMIT 10
      `).bind(chatId).all();
      await answerPromise;
      const recentFiles = await recentFilesPromise;
      if (!recentFiles.results || recentFiles.results.length === 0) {
        await sendMessage(chatId, "⚠️ 您还没有上传过文件", config.tgBotToken);
        return;
      }
      const filesList = recentFiles.results.map((file, i) => {
        const fileName = file.file_name || getFileName(file.url);
        const date = formatDate(file.created_at);
        const storageEmoji = file.storage_type === 'r2' ? '☁️' : '✈️';
        return `${i + 1}. ${fileName}\n   📅 ${date} ${storageEmoji}\n   🔗 ${file.url}`;
      }).join('\n\n');
      const keyboard = {
        inline_keyboard: [
          [{ text: "« 返回", callback_data: "back_to_panel" }]
        ]
      };
      if (config.buttonCache) {
         config.buttonCache.set(cacheKey, {
           timestamp: Date.now(),
           replyText: "📋 您最近上传的文件：\n\n" + filesList,
           replyMarkup: keyboard,
           disablePreview: true
         });
      }
      await fetch(`https://api.telegram.org/bot${config.tgBotToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: "📋 您最近上传的文件：\n\n" + filesList,
          reply_markup: keyboard,
          disable_web_page_preview: true
        })
      });
    }
    else if (cbData === 'edit_suffix_input') {
      await answerPromise;
      await config.database.prepare('UPDATE user_settings SET waiting_for = ? WHERE chat_id = ?')
        .bind('edit_suffix_input_file', chatId).run();
      userSetting.waiting_for = 'edit_suffix_input_file';
      await sendMessage(chatId, "✏️ 请回复此消息，输入要修改后缀的文件完整名称（必须包含扩展名）或完整URL链接", config.tgBotToken);
    }
    else if (cbData === 'delete_file_input') {
      await answerPromise;
      await config.database.prepare('UPDATE user_settings SET waiting_for = ? WHERE chat_id = ?')
        .bind('delete_file_input', chatId).run();
      userSetting.waiting_for = 'delete_file_input';
      await sendMessage(chatId, "🗑️ 请回复此消息，输入要删除的文件完整名称（必须包含扩展名）或完整URL链接", config.tgBotToken);
    }
    else if (cbData.startsWith('delete_file_confirm_')) {
    }
    else if (cbData.startsWith('delete_file_do_')) {
    }
    else if (userSetting.waiting_for === 'edit_suffix_input_file' && update.message.text) {
      console.error('错误: 不应该执行到这里，修改后缀的逻辑已移至handleTelegramWebhook函数');
      try { await answerPromise; } catch {}
      return;
    }
    else if (userSetting.waiting_for === 'edit_suffix_input_new' && update.message.text && userSetting.editing_file_id) {
      console.error('错误: 不应该执行到这里，修改后缀的逻辑已移至handleTelegramWebhook函数');
      try { await answerPromise; } catch {}
      return;
    }
  } catch (error) {
    console.error('处理回调查询时出错:', error);
    try { await answerPromise; } catch {}
    await sendMessage(chatId, `❌ 处理请求时出错: ${error.message}`, config.tgBotToken);
  }
}
async function handleMediaUpload(chatId, file, isDocument, config, userSetting) {
  const processingMessage = await sendMessage(chatId, "⏳ 正在处理您的文件，请稍候...", config.tgBotToken);
  const processingMessageId = processingMessage && processingMessage.result ? processingMessage.result.message_id : null;
  try {
    console.log('原始文件信息:', JSON.stringify(file));
    const filePathPromise = fetch(`https://api.telegram.org/bot${config.tgBotToken}/getFile?file_id=${file.file_id}`)
      .then(response => response.json());
    let categoryId = null;
    let categoryPromise = null;
    if (userSetting && userSetting.current_category_id) {
      categoryId = userSetting.current_category_id;
    } else {
      categoryPromise = config.database.prepare('SELECT id FROM categories WHERE name = ?')
        .bind('默认分类').first()
        .then(async (defaultCategory) => {
          if (!defaultCategory) {
            try {
              console.log('默认分类不存在，正在创建...');
              const result = await config.database.prepare('INSERT INTO categories (name, created_at) VALUES (?, ?)')
                .bind('默认分类', Date.now()).run();
              const newDefaultId = result.meta && result.meta.last_row_id;
              if (newDefaultId) {
                return { id: newDefaultId };
              }
            } catch (error) {
              console.error('创建默认分类失败:', error);
            }
          }
          return defaultCategory;
        });
    }
    const data = await filePathPromise;
    if (!data.ok) throw new Error(`获取文件路径失败: ${JSON.stringify(data)}`);
    console.log('获取到文件路径:', data.result.file_path);
    const fileUrl = `https://api.telegram.org/file/bot${config.tgBotToken}/${data.result.file_path}`;
    const fileResponse = await fetch(fileUrl);
    if (!fileResponse.ok) throw new Error(`获取文件内容失败: ${fileResponse.status} ${fileResponse.statusText}`);
    const contentLength = fileResponse.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > config.maxSizeMB * 1024 * 1024) {
      if (processingMessageId) {
        await fetch(`https://api.telegram.org/bot${config.tgBotToken}/deleteMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: processingMessageId
          })
        }).catch(err => console.error('删除处理消息失败:', err));
      }
      await sendMessage(chatId, `❌ 文件超过${config.maxSizeMB}MB限制`, config.tgBotToken);
      return;
    }
    fetch(`https://api.telegram.org/bot${config.tgBotToken}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: processingMessageId,
        text: "⏳ 文件已接收，正在上传到存储..."
      })
    }).catch(err => console.error('更新处理消息失败:', err));
    if (categoryPromise) {
      const defaultCategory = await categoryPromise;
      if (defaultCategory) {
        categoryId = defaultCategory.id;
      }
    }
    let fileName = '';
    let ext = '';
    let mimeType = file.mime_type || 'application/octet-stream';
    const filePathExt = data.result.file_path.split('.').pop().toLowerCase();
    if (file.file_name) {
      fileName = file.file_name;
      ext = (fileName.split('.').pop() || '').toLowerCase();
    } 
    else if (filePathExt && filePathExt !== data.result.file_path.toLowerCase()) {
      ext = filePathExt;
    } 
    else {
      ext = getExtensionFromMime(mimeType);
    }
    if (!fileName) {
      if (file.video_note) {
        fileName = `video_note_${Date.now()}.${ext}`;
      } else if (file.voice) {
        fileName = `voice_message_${Date.now()}.${ext}`;
      } else if (file.audio) {
        fileName = (file.audio.title || `audio_${Date.now()}`) + `.${ext}`;
      } else if (file.video) {
        fileName = `video_${Date.now()}.${ext}`;
      } else {
        fileName = `file_${Date.now()}.${ext}`;
      }
    }
    if (!mimeType || mimeType === 'application/octet-stream') {
      mimeType = getContentType(ext);
    }
    const mimeParts = mimeType.split('/');
    const mainType = mimeParts[0] || '';
    const subType = mimeParts[1] || '';
    console.log('处理文件:', JSON.stringify({ 
      fileName, 
      ext, 
      mimeType, 
      mainType, 
      subType,
      size: contentLength,
      filePath: data.result.file_path
    }));
    const storageType = userSetting && userSetting.storage_type ? userSetting.storage_type : 'r2';
    let finalUrl, dbFileId, dbMessageId;
    const key = generateSafeKey(fileName); // 使用随机安全key，杂乱的原始文件名只保存进 file_name 字段
    if (storageType === 'r2' && config.bucket) {
      const arrayBuffer = await fileResponse.arrayBuffer();
      await config.bucket.put(key, arrayBuffer, { 
        httpMetadata: { contentType: mimeType } 
      });
      finalUrl = `https://${config.domain}/${key}`;
      dbFileId = key;
      dbMessageId = -1;
    } else {
      let method = 'sendDocument';
      let field = 'document';
      let messageId = null;
      let fileId = null;
      if (mainType === 'image' && !['svg+xml', 'x-icon'].includes(subType)) {
        method = 'sendPhoto';
        field = 'photo';
      } else if (mainType === 'video') {
        method = 'sendVideo';
        field = 'video';
      } else if (mainType === 'audio') {
        method = 'sendAudio';
        field = 'audio';
      } else {
        method = 'sendDocument';
        field = 'document';
      }
      console.log('Telegram上传方法:', { method, field });
      const arrayBuffer = await fileResponse.arrayBuffer();

      if (!config.tgStorageChatId) {
        throw new Error(
          '未配置 TG_STORAGE_CHAT_ID，无法使用 Telegram 存储'
        );
      }
      const tgFormData = new FormData();
      tgFormData.append('chat_id', config.tgStorageChatId);
      const blob = new Blob([arrayBuffer], { type: mimeType });
      tgFormData.append(field, blob, fileName);
      if (field !== 'photo') {
        tgFormData.append('caption', `File: ${fileName}\nType: ${mimeType}\nSize: ${formatSize(parseInt(contentLength || '0'))}`);
      }
      const tgResponse = await fetch(
        `https://api.telegram.org/bot${config.tgBotToken}/${method}`,
        { method: 'POST', body: tgFormData }
      );
      if (!tgResponse.ok) {
        const errorText = await tgResponse.text();
        console.error('Telegram API错误:', errorText);
        if (method !== 'sendDocument') {
          console.log('尝试使用sendDocument方法重新上传');
          const retryFormData = new FormData();
          retryFormData.append('chat_id', config.tgStorageChatId);
          retryFormData.append('document', blob, fileName);
          retryFormData.append('caption', `File: ${fileName}\nType: ${mimeType}\nSize: ${formatSize(parseInt(contentLength || '0'))}`);
          const retryResponse = await fetch(
            `https://api.telegram.org/bot${config.tgBotToken}/sendDocument`,
            { method: 'POST', body: retryFormData }
          );
          if (!retryResponse.ok) {
            console.error('Telegram文档上传也失败:', await retryResponse.text());
            throw new Error('Telegram文件上传失败');
          }
          const retryData = await retryResponse.json();
          const retryResult = retryData.result;
          messageId = retryResult.message_id;
          fileId = retryResult.document?.file_id;
          if (!fileId || !messageId) {
            throw new Error('重试上传后仍未获取到有效的文件ID');
          }
        } else {
          throw new Error('Telegram参数配置错误: ' + errorText);
        }
      } else {
        const tgData = await tgResponse.json();
        const result = tgData.result;
        messageId = result.message_id;
        if (field === 'photo') {
          const photos = result.photo;
          fileId = photos[photos.length - 1]?.file_id; 
        } else if (field === 'video') {
          fileId = result.video?.file_id;
        } else if (field === 'audio') {
          fileId = result.audio?.file_id;
        } else {
          fileId = result.document?.file_id;
        }
      }
      if (!fileId) throw new Error('未获取到文件ID');
      if (!messageId) throw new Error('未获取到tg消息ID');
      finalUrl = `https://${config.domain}/${key}`;
      dbFileId = fileId;
      dbMessageId = messageId;
    }
    await fetch(`https://api.telegram.org/bot${config.tgBotToken}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: processingMessageId,
        text: "⏳ 正在写入数据库..."
      })
    }).catch(err => console.error('更新处理消息失败:', err));
    const time = Date.now(); 
    await config.database.prepare(`
      INSERT INTO files (
        url, 
        fileId, 
        message_id, 
        created_at, 
        file_name, 
        file_size, 
        mime_type, 
        chat_id, 
        category_id, 
        storage_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      finalUrl,
      dbFileId,
      dbMessageId,
      time, 
      fileName, 
      contentLength,
      mimeType,
      chatId,
      categoryId,
      storageType
    ).run();
    if (processingMessageId) {
      await fetch(`https://api.telegram.org/bot${config.tgBotToken}/deleteMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: processingMessageId
        })
      }).catch(err => console.error('删除处理消息失败:', err));
    }
    const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(finalUrl)}`;
    await fetch(`https://api.telegram.org/bot${config.tgBotToken}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        photo: qrCodeUrl,
        caption: `✅ 文件上传成功\n\n📝 图床直链：\n${finalUrl}\n\n🔍 扫描上方二维码快速访问`,
        parse_mode: 'HTML'
      })
    });
  } catch (error) {
    console.error("Error handling media upload:", error);
    if (processingMessageId) {
      await fetch(`https://api.telegram.org/bot${config.tgBotToken}/deleteMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: processingMessageId
        })
      }).catch(err => console.error('删除处理消息失败:', err));
    }
    await sendMessage(chatId, `❌ 上传失败: ${error.message}`, config.tgBotToken);
  }
}
async function getTelegramFileUrl(fileId, botToken, config) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
  const data = await response.json();
  if (!data.ok) throw new Error('获取文件路径失败');
  const filePath = data.result.file_path;
  const fileName = filePath.split('/').pop();
  const timestamp = Date.now();
  const fileExt = fileName.split('.').pop();
  const newFileName = `${timestamp}.${fileExt}`;
  if (config && config.domain) {
    return `https://${config.domain}/${newFileName}`;
  } else {
    return `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  }
}
function authenticate(request, config) {
  if (!config.enableAuth) {
    console.log('[Auth] Authentication disabled.');
    return true;
  }
  if (!config.username || !config.password) {
    console.error("[Auth] FAILED: Missing USERNAME or PASSWORD configuration while auth is enabled.");
    return false;
  }
  const cookies = request.headers.get("Cookie") || "";
  const authToken = cookies.match(/auth_token=([^;]+)/);
  if (!authToken) {
    console.log('[Auth] FAILED: No auth_token cookie found.');
    return false;
  }
  try {
    const tokenData = JSON.parse(atob(authToken[1]));
    const now = Date.now();
    if (now > tokenData.expiration) {
      console.log("[Auth] FAILED: Token expired.");
      return false;
    }
    if (tokenData.username !== config.username) {
      console.log("[Auth] FAILED: Token username mismatch.");
      return false;
    }
    console.log('[Auth] SUCCESS: Valid token found.');
    return true;
  } catch (error) {
    console.error("[Auth] FAILED: Error validating token:", error);
    return false;
  }
}
async function handleAuthRequest(request, config) {
  if (config.enableAuth) {
    const isAuthenticated = authenticate(request, config);
    if (!isAuthenticated) {
      return handleLoginRequest(request, config);
    }
    return handleUploadRequest(request, config);
  }
  return handleUploadRequest(request, config);
}
async function handleLoginRequest(request, config) {
  if (request.method === 'POST') {
    const { username, password } = await request.json();
    if (username === config.username && password === config.password) {
      const expirationDate = new Date();
      const cookieDays = config.cookie || 7;
      expirationDate.setDate(expirationDate.getDate() + cookieDays);
      const expirationTimestamp = expirationDate.getTime();
      const tokenData = JSON.stringify({
        username: config.username,
        expiration: expirationTimestamp
      });
      const token = btoa(tokenData);
      const cookie = `auth_token=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${expirationDate.toUTCString()}`;
      return new Response("登录成功", {
        status: 200,
        headers: {
          "Set-Cookie": cookie,
          "Content-Type": "text/plain"
        }
      });
    }
    return new Response("认证失败", { status: 401 });
  }
  const html = generateLoginPage();
  return new Response(html, {
    headers: { 'Content-Type': 'text/html;charset=UTF-8' }
  });
}
async function handleCreateCategoryRequest(request, config) {
  if (config.enableAuth && !authenticate(request, config)) {
    return new Response(JSON.stringify({ status: 0, msg: "未授权" }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  try {
    const { name } = await request.json();
    if (!name || typeof name !== 'string' || name.trim() === '') {
      return new Response(JSON.stringify({ status: 0, msg: "分类名称不能为空" }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const categoryName = name.trim();
    const time = Date.now();
    const existingCategory = await config.database.prepare('SELECT id FROM categories WHERE name = ?').bind(categoryName).first();
    if (existingCategory) {
      return new Response(JSON.stringify({ status: 0, msg: `分类 "${categoryName}" 已存在，请选择一个不同的名称！` }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    await config.database.prepare('INSERT INTO categories (name, created_at) VALUES (?, ?)')
      .bind(categoryName, time).run();
    const category = await config.database.prepare('SELECT id FROM categories WHERE name = ?').bind(categoryName).first();
    return new Response(JSON.stringify({ status: 1, msg: "分类创建成功", category: { id: category.id, name: categoryName } }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ status: 0, msg: `创建分类失败：${error.message}` }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
async function handleDeleteCategoryRequest(request, config) {
  if (config.enableAuth && !authenticate(request, config)) {
    return new Response(JSON.stringify({ status: 0, msg: "未授权" }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  try {
    const { id } = await request.json();
    if (!id || isNaN(id)) {
      return new Response(JSON.stringify({ status: 0, msg: "分类ID无效" }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const isDefaultCategory = await config.database.prepare('SELECT id FROM categories WHERE id = ? AND name = ?')
      .bind(id, '默认分类').first();
    if (isDefaultCategory) {
      return new Response(JSON.stringify({ status: 0, msg: "默认分类不能删除" }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const category = await config.database.prepare('SELECT name FROM categories WHERE id = ?').bind(id).first();
    if (!category) {
      return new Response(JSON.stringify({ status: 0, msg: "分类不存在" }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const defaultCategory = await config.database.prepare('SELECT id FROM categories WHERE name = ?')
      .bind('默认分类').first();
    let defaultCategoryId;
    if (!defaultCategory) {
      const result = await config.database.prepare('INSERT INTO categories (name, created_at) VALUES (?, ?)')
        .bind('默认分类', Date.now()).run();
      defaultCategoryId = result.meta && result.meta.last_row_id ? result.meta.last_row_id : null;
      console.log('创建了新的默认分类，ID:', defaultCategoryId);
    } else {
      defaultCategoryId = defaultCategory.id;
    }
    if (defaultCategoryId) {
      await config.database.prepare('UPDATE files SET category_id = ? WHERE category_id = ?')
        .bind(defaultCategoryId, id).run();
      await config.database.prepare('UPDATE user_settings SET current_category_id = ? WHERE current_category_id = ?')
        .bind(defaultCategoryId, id).run();
    } else {
      await config.database.prepare('UPDATE files SET category_id = NULL WHERE category_id = ?').bind(id).run();
      await config.database.prepare('UPDATE user_settings SET current_category_id = NULL WHERE current_category_id = ?').bind(id).run();
    }
    await config.database.prepare('DELETE FROM categories WHERE id = ?').bind(id).run();
    return new Response(JSON.stringify({ 
      status: 1, 
      msg: `分类 "${category.name}" 删除成功${defaultCategoryId ? '，相关文件已移至默认分类' : ''}` 
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('删除分类失败:', error);
    return new Response(JSON.stringify({ status: 0, msg: `删除分类失败：${error.message}` }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
async function handleUploadRequest(request, config) {
  if (
    config.enableAuth &&
    !authenticate(request, config)
  ) {
    return Response.redirect(
      `${new URL(request.url).origin}/`,
      302
    );
  }

  const chatId = getWebOwnerChatId(config);

  if (!chatId) {
    return new Response(
      '未配置 TG_ADMIN_ID，网页上传无法确定文件归属用户',
      {
        status: 500,
        headers: {
          'Content-Type': 'text/plain;charset=UTF-8',
          'Cache-Control': 'no-store'
        }
      }
    );
  }
  if (request.method === 'GET') {
    const categories = await config.database.prepare('SELECT id, name FROM categories').all();
    const categoryOptions = categories.results.length
      ? categories.results.map(c => `<option value="${c.id}">${c.name}</option>`).join('')
      : '<option value="">暂无分类</option>';
    let userSetting = await config.database.prepare('SELECT * FROM user_settings WHERE chat_id = ?').bind(chatId).first();
    if (!userSetting) {
      const defaultCategory = await config.database.prepare('SELECT id FROM categories WHERE name = ?').bind('默认分类').first();
      await config.database.prepare('INSERT INTO user_settings (chat_id, storage_type, current_category_id) VALUES (?, ?, ?)')
        .bind(chatId, 'telegram', defaultCategory.id).run();
      userSetting = { storage_type: 'telegram', current_category_id: defaultCategory.id };
    }
    const html = generateUploadPage(categoryOptions, userSetting.storage_type);
    return new Response(html, {
      headers: { 'Content-Type': 'text/html;charset=UTF-8' }
    });
  }
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    const categoryId = formData.get('category');
    const storageType = formData.get('storage_type');
    if (!file) throw new Error('未找到文件');
    if (file.size > config.maxSizeMB * 1024 * 1024) throw new Error(`文件超过${config.maxSizeMB}MB限制`);
    let defaultCategory = await config.database.prepare('SELECT id FROM categories WHERE name = ?').bind('默认分类').first();
    if (!defaultCategory) {
      try {
        console.log('默认分类不存在，正在创建...');
        const result = await config.database.prepare('INSERT INTO categories (name, created_at) VALUES (?, ?)')
          .bind('默认分类', Date.now()).run();
        const newDefaultId = result.meta && result.meta.last_row_id;
        if (newDefaultId) {
          defaultCategory = { id: newDefaultId };
          console.log(`已创建新的默认分类，ID: ${newDefaultId}`);
        }
      } catch (error) {
        console.error('创建默认分类失败:', error);
        defaultCategory = { id: categoryId || null };
      }
    }
    const finalCategoryId = categoryId || (defaultCategory ? defaultCategory.id : null);
    await config.database.prepare('UPDATE user_settings SET storage_type = ?, current_category_id = ? WHERE chat_id = ?')
      .bind(storageType, finalCategoryId, chatId).run();

    // 原始扩展名（仅用于判断 MIME 类型 / Telegram 上传方法，不再直接拼进 URL）
    const rawExt = (file.name.split('.').pop() || '').toLowerCase();
    const mimeType = file.type || getContentType(rawExt);
    const [mainType] = mimeType.split('/');
    const typeMap = {
      image: { method: 'sendPhoto', field: 'photo' },
      video: { method: 'sendVideo', field: 'video' },
      audio: { method: 'sendAudio', field: 'audio' }
    };
    let { method = 'sendDocument', field = 'document' } = typeMap[mainType] || {};
    if (['application', 'text'].includes(mainType)) {
      method = 'sendDocument';
      field = 'document';
    }

    // 统一在这里生成一次 key，全程复用，避免存储路径与数据库URL不一致
    const key = generateSafeKey(file.name);
    const finalUrl = `https://${config.domain}/${key}`;

    let dbFileId, dbMessageId;

    if (storageType === 'r2') {
      if (!config.bucket) throw new Error('未配置R2存储桶(BUCKET)，无法使用R2存储');
      await config.bucket.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: mimeType } });
      dbFileId = key;
      dbMessageId = -1;
    } else {
      if (!config.tgStorageChatId) {
        throw new Error(
          '未配置 TG_STORAGE_CHAT_ID，无法使用 Telegram 存储'
        );
      }
    
      const tgFormData = new FormData();
      tgFormData.append(
        'chat_id',
        config.tgStorageChatId
      );
      tgFormData.append(field, file, file.name);
      const tgResponse = await fetch(
        `https://api.telegram.org/bot${config.tgBotToken}/${method}`,
        { method: 'POST', body: tgFormData }
      );
      if (!tgResponse.ok) throw new Error('Telegram参数配置错误');
      const tgData = await tgResponse.json();
      const result = tgData.result;
      const messageId = result.message_id;
      const fileId = result.document?.file_id ||
                     result.video?.file_id ||
                     result.audio?.file_id ||
                     (result.photo && result.photo[result.photo.length - 1]?.file_id);
      if (!fileId) throw new Error('未获取到文件ID');
      if (!messageId) throw new Error('未获取到tg消息ID');
      dbFileId = fileId;
      dbMessageId = messageId;
    }

    const time = Date.now();
    const timestamp = new Date(time + 8 * 60 * 60 * 1000).toISOString();
    
    await config.database.prepare(`
      INSERT INTO files (url, fileId, message_id, created_at, file_name, file_size, mime_type, storage_type, category_id, chat_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      finalUrl,
      dbFileId,
      dbMessageId,
      timestamp,
      file.name,
      file.size,
      mimeType,
      storageType,
      finalCategoryId,
      chatId
    ).run();

    return new Response(
      JSON.stringify({ status: 1, msg: "✔ 上传成功", url: finalUrl }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error(`[Upload Error] ${error.message}`);
    let statusCode = 500;
    if (error.message.includes(`文件超过${config.maxSizeMB}MB限制`)) {
      statusCode = 400;
    } else if (error.message.includes('Telegram参数配置错误')) {
      statusCode = 502;
    } else if (error.message.includes('未获取到文件ID') || error.message.includes('未获取到tg消息ID')) {
      statusCode = 500;
    } else if (error instanceof TypeError && error.message.includes('Failed to fetch')) {
      statusCode = 504;
    }
    return new Response(
      JSON.stringify({ status: 0, msg: "✘ 上传失败", error: error.message }),
      { status: statusCode, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
async function handleDeleteMultipleRequest(request, config) {
  if (config.enableAuth && !authenticate(request, config)) {
    return Response.redirect(`${new URL(request.url).origin}/`, 302);
  }
  try {
    const { urls } = await request.json();
    if (!Array.isArray(urls) || urls.length === 0) {
      return new Response(JSON.stringify({ 
        status: 0, 
        error: '无效的URL列表' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const results = {
      success: [],
      failed: []
    };
    for (const url of urls) {
      try {
        const fileName = url.split('/').pop();
        let file = await config.database.prepare(
          'SELECT id, fileId, message_id, storage_type FROM files WHERE url = ?'
        ).bind(url).first();
        if (!file && fileName) {
          file = await config.database.prepare(
            'SELECT id, fileId, message_id, storage_type FROM files WHERE fileId = ?'
          ).bind(fileName).first();
        }
        if (file) {
          console.log(`正在删除文件: ${url}, 存储类型: ${file.storage_type}`);
          if (file.storage_type === 'telegram' && file.message_id) {
            try {
              await fetch(
                `https://api.telegram.org/bot${config.tgBotToken}/deleteMessage?chat_id=${config.tgStorageChatId}&message_id=${file.message_id}`
              );
              console.log(`已从Telegram删除消息: ${file.message_id}`);
            } catch (error) {
              console.error(`从Telegram删除消息失败: ${error.message}`);
            }
          } else if (file.storage_type === 'r2' && file.fileId && config.bucket) {
            try {
              await config.bucket.delete(file.fileId);
              console.log(`已从R2删除文件: ${file.fileId}`);
            } catch (error) {
              console.error(`从R2删除文件失败: ${error.message}`);
            }
          }
          await config.database.prepare('DELETE FROM files WHERE id = ?').bind(file.id).run();
          console.log(`已从数据库删除记录: ID=${file.id}`);
          results.success.push(url);
        } else {
          console.log(`未找到文件记录: ${url}`);
          results.failed.push({url, reason: '未找到文件记录'});
        }
      } catch (error) {
        console.error(`删除文件失败 ${url}: ${error.message}`);
        results.failed.push({url, reason: error.message});
      }
    }
    return new Response(
      JSON.stringify({ 
        status: 1, 
        message: '批量删除处理完成',
        results: {
          success: results.success.length,
          failed: results.failed.length,
          details: results
        }
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error(`[Delete Multiple Error] ${error.message}`);
    return new Response(
      JSON.stringify({ 
        status: 0, 
        error: error.message 
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
function createApiJsonResponse(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Cache-Control': 'no-store'
      }
    }
  );
}

// 用户管理页面
async function handleUserManagementRequest(request, config) {
  if (request.method !== 'GET') {
    return new Response(
      'Method Not Allowed',
      {
        status: 405,
        headers: {
          'Cache-Control': 'no-store'
        }
      }
    );
  }

  return new Response(
    generateUserManagementPage(),
    {
      headers: {
        'Content-Type': 'text/html;charset=UTF-8',
        'Cache-Control': 'no-store'
      }
    }
  );
}

// 获取管理员和普通授权用户
async function handleListAllowedUsersRequest(request, config) {
  if (request.method !== 'GET') {
    return createApiJsonResponse(
      {
        status: 0,
        error: 'Method Not Allowed'
      },
      405
    );
  }

  try {
    const users = await listAllowedTelegramUsers(config);

    return createApiJsonResponse({
      status: 1,
      admins: config.tgAdminId || [],
      users
    });
  } catch (error) {
    console.error('获取授权用户列表失败:', error);

    return createApiJsonResponse(
      {
        status: 0,
        error: error.message
      },
      500
    );
  }
}

// 网页添加授权用户
async function handleAddAllowedUserRequest(request, config) {
  if (request.method !== 'POST') {
    return createApiJsonResponse(
      {
        status: 0,
        error: 'Method Not Allowed'
      },
      405
    );
  }

  try {
    const body = await request.json();
    const chatId = normalizeTelegramUserId(
      body && body.chat_id
    );

    if (!chatId) {
      return createApiJsonResponse(
        {
          status: 0,
          error: '请输入正确的纯数字 Telegram 用户 ID'
        },
        400
      );
    }

    const result = await addAllowedTelegramUser(
      chatId,
      `web:${config.username || 'admin'}`,
      config
    );

    let message = '';

    if (result.alreadyAdmin) {
      message = '该用户已经是 TG_ADMIN_ID 管理员';
    } else if (result.created) {
      message = '用户添加成功';
    } else {
      message = '该用户已经在授权列表中';
    }

    return createApiJsonResponse({
      status: 1,
      created: result.created,
      already_admin: result.alreadyAdmin,
      chat_id: chatId,
      message
    });
  } catch (error) {
    console.error('网页添加授权用户失败:', error);

    return createApiJsonResponse(
      {
        status: 0,
        error: error.message
      },
      500
    );
  }
}

// 网页删除授权用户
async function handleDeleteAllowedUserRequest(request, config) {
  if (request.method !== 'POST') {
    return createApiJsonResponse(
      {
        status: 0,
        error: 'Method Not Allowed'
      },
      405
    );
  }

  try {
    const body = await request.json();
    const chatId = normalizeTelegramUserId(
      body && body.chat_id
    );

    if (!chatId) {
      return createApiJsonResponse(
        {
          status: 0,
          error: '用户 ID 格式不正确'
        },
        400
      );
    }

    const removed = await removeAllowedTelegramUser(
      chatId,
      config
    );

    return createApiJsonResponse({
      status: 1,
      removed,
      chat_id: chatId,
      message: removed
        ? '用户权限已删除'
        : '该用户已不在授权列表中'
    });
  } catch (error) {
    console.error('网页删除授权用户失败:', error);

    return createApiJsonResponse(
      {
        status: 0,
        error: error.message
      },
      400
    );
  }
}
async function handleAdminRequest(request, config) {
  if (config.enableAuth && !authenticate(request, config)) {
    return Response.redirect(`${new URL(request.url).origin}/`, 302);
  }
  try {
    const categories = await config.database.prepare('SELECT id, name FROM categories').all();
    const categoryOptions = categories.results.length
      ? categories.results.map(c => `<option value="${c.id}">${c.name}</option>`).join('')
      : '<option value="">暂无分类</option>';
    const files = await config.database.prepare(`
      SELECT f.url, f.fileId, f.message_id, f.created_at, f.file_name, f.file_size, f.mime_type, f.storage_type, c.name as category_name, c.id as category_id
      FROM files f
      LEFT JOIN categories c ON f.category_id = c.id
      ORDER BY f.created_at DESC
    `).all();
    const fileList = files.results || [];
    console.log(`文件总数: ${fileList.length}`);
    const fileCards = fileList.map(file => {
        const url = file.url;
        const uniqueId = `file-checkbox-${encodeURIComponent(url)}`;
        return `
          <div class="file-card" data-url="${url}" data-category-id="${file.category_id || ''}">
            <input type="checkbox" id="${uniqueId}" name="selectedFile" class="file-checkbox" value="${url}">
            <div class="file-preview">
              ${getPreviewHtml(url)}
            </div>
            <div class="file-info">
              <div>${getFileName(url)}</div>
              <div>大小: ${formatSize(file.file_size || 0)}</div>
              <div>上传时间: ${formatDate(file.created_at)}</div>
              <div>分类: ${file.category_name || '无分类'}</div>
            </div>
            <div class="file-actions" style="display:flex; gap:5px; justify-content:space-between; padding:10px;">
              <button class="btn btn-share" style="flex:1; background-color:#3498db; color:white; padding:8px 12px; border-radius:6px; border:none; cursor:pointer; font-weight:bold;" onclick="shareFile('${url}', '${getFileName(url)}')">分享</button>
              <button class="btn btn-delete" style="flex:1;" onclick="showConfirmModal('确定要删除这个文件吗？', function() { deleteFile('${url}'); })">删除</button>
              <button class="btn btn-edit" style="flex:1;" onclick="showEditSuffixModal('${url}')">修改后缀</button>
            </div>
          </div>
        `;
    }).join('');
    const html = generateAdminPage(fileCards, categoryOptions);
    return new Response(html, {
      headers: { 'Content-Type': 'text/html;charset=UTF-8' }
    });
  } catch (error) {
    console.error(`[Admin Error] ${error.message}`);
    return new Response(`加载文件列表失败，请检查数据库配置：${error.message}`, { status: 500 });
  }
}
async function handleSearchRequest(request, config) {
  if (config.enableAuth && !authenticate(request, config)) {
    return Response.redirect(`${new URL(request.url).origin}/`, 302);
  }
  try {
    const { query } = await request.json();
    const searchPattern = `%${query}%`;
    const files = await config.database.prepare(`
      SELECT url, fileId, message_id, created_at, file_name, file_size, mime_type
       FROM files 
       WHERE file_name LIKE ? ESCAPE '!'
       COLLATE NOCASE
       ORDER BY created_at DESC
    `).bind(searchPattern).all();
    return new Response(
      JSON.stringify({ files: files.results || [] }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error(`[Search Error] ${error.message}`);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
function getPreviewHtml(url) {
  const ext = (url.split('.').pop() || '').toLowerCase();
  const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'icon'].includes(ext);
  const isVideo = ['mp4', 'webm'].includes(ext);
  const isAudio = ['mp3', 'wav', 'ogg'].includes(ext);
  if (isImage) {
    return `<img src="${url}" alt="预览">`;
  } else if (isVideo) {
    return `<video src="${url}" controls></video>`;
  } else if (isAudio) {
    return `<audio src="${url}" controls></audio>`;
  } else {
    return `<div style="font-size: 48px">📄</div>`;
  }
}
async function handleFileRequest(request, config) {
  try {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname.slice(1));
    if (!path) {
      return new Response('Not Found', { status: 404 });
    }
    const cacheKey = `file:${path}`;
    if (config.fileCache && config.fileCache.has(cacheKey)) {
      const cachedData = config.fileCache.get(cacheKey);
      if (Date.now() - cachedData.timestamp < config.fileCacheTTL) {
        console.log(`从缓存提供文件: ${path}`);
        return cachedData.response.clone();
      } else {
        config.fileCache.delete(cacheKey);
      }
    }
    const cacheAndReturnResponse = (response) => {
      if (config.fileCache) {
        config.fileCache.set(cacheKey, {
          response: response.clone(),
          timestamp: Date.now()
        });
      }
      return response;
    };
    const getCommonHeaders = (contentType) => {
      const headers = new Headers();
      headers.set('Content-Type', contentType);
      headers.set('Access-Control-Allow-Origin', '*');
      if (contentType.startsWith('image/') || 
          contentType.startsWith('video/') || 
          contentType.startsWith('audio/')) {
        headers.set('Content-Disposition', 'inline');
      }
      headers.set('Cache-Control', 'public, max-age=31536000');
      return headers;
    };
    if (config.bucket) {
      try {
        const object = await config.bucket.get(path);
        if (object) {
          const contentType = object.httpMetadata.contentType || getContentType(path.split('.').pop());
          const headers = getCommonHeaders(contentType);
          object.writeHttpMetadata(headers);
          headers.set('etag', object.httpEtag);
          return cacheAndReturnResponse(new Response(object.body, { headers }));
        }
      } catch (error) {
        if (error.name !== 'NoSuchKey') {
          console.error('R2获取文件错误:', error.name);
        }
      }
    }
    let file;
    const urlPattern = `https://${config.domain}/${path}`;
    file = await config.database.prepare('SELECT * FROM files WHERE url = ?').bind(urlPattern).first();
    if (!file) {
      file = await config.database.prepare('SELECT * FROM files WHERE fileId = ?').bind(path).first();
    }
    if (!file) {
      const fileName = path.split('/').pop();
      file = await config.database.prepare('SELECT * FROM files WHERE file_name = ?').bind(fileName).first();
    }
    if (!file) {
      return new Response('File not found', { status: 404 });
    }
    if (file.storage_type === 'telegram') {
      try {
        const telegramFileId = file.fileId;
        if (!telegramFileId) {
          console.error('文件记录缺少Telegram fileId');
          return new Response('Missing Telegram file ID', { status: 500 });
        }
        const response = await fetch(`https://api.telegram.org/bot${config.tgBotToken}/getFile?file_id=${telegramFileId}`);
        const data = await response.json();
        if (!data.ok) {
          console.error('Telegram getFile 失败:', data.description);
          return new Response('Failed to get file from Telegram', { status: 500 });
        }
        const telegramUrl = `https://api.telegram.org/file/bot${config.tgBotToken}/${data.result.file_path}`;
        const fileResponse = await fetch(telegramUrl);
        if (!fileResponse.ok) {
          console.error(`从Telegram获取文件失败: ${fileResponse.status}`);
          return new Response('Failed to fetch file from Telegram', { status: fileResponse.status });
        }
        const contentType = file.mime_type || getContentType(path.split('.').pop());
        const headers = getCommonHeaders(contentType);
        return cacheAndReturnResponse(new Response(fileResponse.body, { headers }));
      } catch (error) {
        console.error('处理Telegram文件出错:', error.message);
        return new Response('Error processing Telegram file', { status: 500 });
      }
    } 
    else if (file.storage_type === 'r2' && config.bucket) {
      try {
        const object = await config.bucket.get(file.fileId);
        if (object) {
          const contentType = object.httpMetadata.contentType || file.mime_type || getContentType(path.split('.').pop());
          const headers = getCommonHeaders(contentType);
          object.writeHttpMetadata(headers);
          headers.set('etag', object.httpEtag);
          return cacheAndReturnResponse(new Response(object.body, { headers }));
        }
      } catch (error) {
        console.error('通过fileId从R2获取文件出错:', error.message);
      }
    }
    if (file.url && file.url !== urlPattern) {
      return Response.redirect(file.url, 302);
    }
    return new Response('File not available', { status: 404 });
  } catch (error) {
    console.error('处理文件请求出错:', error.message);
    return new Response('Internal Server Error', { status: 500 });
  }
}
async function handleDeleteRequest(request, config) {
  if (config.enableAuth && !authenticate(request, config)) {
    return Response.redirect(`${new URL(request.url).origin}/`, 302);
  }
  try {
    const { id, fileId } = await request.json();
    if (!id && !fileId) {
      return new Response(JSON.stringify({
        status: 0,
        message: '缺少文件标识信息'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    let file;
    if (id && id.startsWith('http')) {
      file = await config.database.prepare('SELECT * FROM files WHERE url = ?').bind(id).first();
    } else if (id) {
      file = await config.database.prepare('SELECT * FROM files WHERE id = ?').bind(id).first();
    }
    if (!file && fileId) {
      file = await config.database.prepare('SELECT * FROM files WHERE fileId = ?').bind(fileId).first();
    }
    if (!file) {
      return new Response(JSON.stringify({
        status: 0,
        message: '文件不存在'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    console.log('准备删除文件:', {
      fileId: file.fileId,
      url: file.url,
      存储类型: file.storage_type
    });
    if (file.storage_type === 'r2' && config.bucket) {
      await deleteFile(file.fileId, config);
      console.log('已从R2存储中删除文件:', file.fileId);
    }
    await config.database.prepare('DELETE FROM files WHERE id = ?').bind(file.id).run();
    console.log('已从数据库中删除文件记录');
    return new Response(JSON.stringify({
      status: 1,
      message: '删除成功'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('删除文件失败:', error);
    return new Response(JSON.stringify({
      status: 0,
      message: '删除文件失败: ' + error.message
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
function getContentType(ext) {
  const types = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    avif: 'image/avif',
    ico: 'image/x-icon',
    icon: 'image/x-icon',
    bmp: 'image/bmp',
    tiff: 'image/tiff',
    tif: 'image/tiff',
    mp4: 'video/mp4',
    webm: 'video/webm',
    ogv: 'video/ogg',
    avi: 'video/x-msvideo',
    mov: 'video/quicktime',
    wmv: 'video/x-ms-wmv',
    flv: 'video/x-flv',
    mkv: 'video/x-matroska',
    m4v: 'video/x-m4v',
    ts: 'video/mp2t',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    flac: 'audio/flac',
    wma: 'audio/x-ms-wma',
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    rtf: 'application/rtf',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    html: 'text/html',
    htm: 'text/html',
    css: 'text/css',
    js: 'application/javascript',
    xml: 'application/xml',
    json: 'application/json',
    zip: 'application/zip',
    rar: 'application/x-rar-compressed',
    '7z': 'application/x-7z-compressed',
    tar: 'application/x-tar',
    gz: 'application/gzip',
    swf: 'application/x-shockwave-flash',
    ttf: 'font/ttf',
    otf: 'font/otf',
    woff: 'font/woff',
    woff2: 'font/woff2',
    eot: 'application/vnd.ms-fontobject',
    ini: 'text/plain',
    yml: 'application/yaml',
    yaml: 'application/yaml',
    toml: 'text/plain',
    py: 'text/x-python',
    java: 'text/x-java',
    c: 'text/x-c',
    cpp: 'text/x-c++',
    cs: 'text/x-csharp',
    php: 'application/x-php',
    rb: 'text/x-ruby',
    go: 'text/x-go',
    rs: 'text/x-rust',
    sh: 'application/x-sh',
    bat: 'application/x-bat',
    sql: 'application/sql'
  };
  const lowerExt = ext.toLowerCase();
  return types[lowerExt] || 'application/octet-stream';
}
async function handleBingImagesRequest(request, config) {
  const cache = caches.default;
  const cacheKey = new Request('https://cn.bing.com/HPImageArchive.aspx?format=js&idx=0&n=5');
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) {
    console.log('Returning cached response');
    return cachedResponse;
  }
  try {
    const res = await fetch(cacheKey);
    if (!res.ok) {
      console.error(`Bing API 请求失败，状态码：${res.status}`);
      return new Response('请求 Bing API 失败', { status: res.status });
    }
    const bingData = await res.json();
    const images = bingData.images.map(image => ({ url: `https://cn.bing.com${image.url}` }));
    const returnData = { status: true, message: "操作成功", data: images };
    const response = new Response(JSON.stringify(returnData), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=21600',
        'Access-Control-Allow-Origin': '*'
      }
    });
    await cache.put(cacheKey, response.clone());
    console.log('响应数据已缓存');
    return response;
  } catch (error) {
    console.error('请求 Bing API 过程中发生错误:', error);
    return new Response('请求 Bing API 失败', { status: 500 });
  }
}
function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(2)} ${units[unitIndex]}`;
}
function formatDate(timestamp) {
  if (!timestamp) return '未知时间';
  let date;
  try {
    let msTimestamp;
    if (typeof timestamp === 'number') {
      msTimestamp = timestamp > 9999999999 ? timestamp : timestamp * 1000;
    } else if (typeof timestamp === 'string') {
      date = new Date(timestamp);
      if (!isNaN(date.getTime())) {
        msTimestamp = date.getTime();
      } else {
        const numTimestamp = parseInt(timestamp);
        if (!isNaN(numTimestamp)) {
          msTimestamp = numTimestamp > 9999999999 ? numTimestamp : numTimestamp * 1000;
        } else {
          return '日期无效 (无法解析)';
        }
      }
    } else if (timestamp instanceof Date) {
      msTimestamp = timestamp.getTime();
    } else {
       return '日期无效 (类型错误)';
    }
    if (msTimestamp < 0 || msTimestamp > 8640000000000000) {
        return '日期无效 (范围超限)';
    }
    date = new Date(msTimestamp);
    if (isNaN(date.getTime())) {
        return '日期无效 (转换失败)';
    }
    const beijingTimeOffset = 8 * 60 * 60 * 1000;
    const beijingDate = new Date(date.getTime() + beijingTimeOffset);
    const year = beijingDate.getUTCFullYear();
    const month = (beijingDate.getUTCMonth() + 1).toString().padStart(2, '0');
    const day = beijingDate.getUTCDate().toString().padStart(2, '0');
    const hours = beijingDate.getUTCHours().toString().padStart(2, '0');
    const minutes = beijingDate.getUTCMinutes().toString().padStart(2, '0');
    const seconds = beijingDate.getUTCSeconds().toString().padStart(2, '0');
    return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`;
  } catch (error) {
    console.error("formatDate 错误:", error, "原始输入:", timestamp);
    return '日期格式化错误';
  }
}
async function sendMessage(chatId, text, botToken, replyToMessageId = null) {
  try {
    const requestBody = {
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML'
    };
    if (replyToMessageId) {
      requestBody.reply_to_message_id = replyToMessageId;
    }
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });
    if (!response.ok) {
      const errorData = await response.text();
      console.error(`发送消息失败: HTTP ${response.status}, ${errorData}`);
      return null;
    }
    return await response.json();
  } catch (error) {
    console.error('发送消息错误:', error);
    return null;
  }
}
function generateLoginPage() {
  return `<!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <link rel="shortcut icon" href="https://tc-212.pages.dev/1744302340226.ico" type="image/x-icon">
    <meta name="description" content="文件存储与分享平台">
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>登录</title>
    <style>
      body {
        font-family: 'Segoe UI', Arial, sans-serif;
        margin: 0;
        padding: 0;
        min-height: 100vh;
        background: linear-gradient(135deg, #f0f4f8, #d9e2ec);
        display: flex;
        justify-content: center;
        align-items: center;
      }
      .container {
        max-width: 400px;
        width: 100%;
        background: rgba(255, 255, 255, 0.95);
        border-radius: 15px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.1);
        padding: 2rem;
        margin: 20px;
      }
      .header {
        margin-bottom: 1.5rem;
        text-align: center;
      }
      h1 {
        color: #2c3e50;
        margin: 0;
        font-size: 1.8rem;
        font-weight: 600;
      }
      .form-group {
        margin-bottom: 1.5rem;
      }
      .form-group label {
        display: block;
        margin-bottom: 0.5rem;
        color: #2c3e50;
        font-weight: 500;
      }
      .form-group input {
        width: 100%;
        padding: 0.8rem;
        border: 2px solid #dfe6e9;
        border-radius: 8px;
        font-size: 1rem;
        background: #fff;
        transition: border-color 0.3s ease, box-shadow 0.3s ease;
        box-sizing: border-box;
      }
      .form-group input:focus {
        outline: none;
        border-color: #3498db;
        box-shadow: 0 0 8px rgba(52,152,219,0.3);
      }
      .btn-login {
        width: 100%;
        padding: 0.8rem;
        background: #3498db;
        color: white;
        border: none;
        border-radius: 8px;
        font-size: 1rem;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.3s ease;
      }
      .btn-login:hover {
        background: #2980b9;
      }
      .error-message {
        color: #e74c3c;
        margin-top: 1rem;
        padding: 0.8rem;
        background: rgba(231, 76, 60, 0.1);
        border-radius: 8px;
        display: none;
      }
      .success-message {
        color: #27ae60;
        margin-top: 1rem;
        padding: 0.8rem;
        background: rgba(39, 174, 96, 0.1);
        border-radius: 8px;
        display: none;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h1>登录</h1>
        <p>请输入管理员账号和密码</p>
      </div>
      <form id="loginForm">
        <div class="form-group">
          <label for="username">用户名</label>
          <input type="text" id="username" name="username" required>
        </div>
        <div class="form-group">
          <label for="password">密码</label>
          <input type="password" id="password" name="password" required>
        </div>
        <button type="submit" class="btn-login">登录</button>
      </form>
      <div id="errorMessage" class="error-message"></div>
      <div id="successMessage" class="success-message"></div>
    </div>
    <script>
      const urlParams = new URLSearchParams(window.location.search);
      const redirectPath = urlParams.get('redirect') || '/upload';
      document.getElementById('loginForm').addEventListener('submit', async function(event) {
        event.preventDefault();
        const username = document.getElementById('username').value;
        const password = document.getElementById('password').value;
        const errorMessage = document.getElementById('errorMessage');
        const successMessage = document.getElementById('successMessage');
        errorMessage.style.display = 'none';
        successMessage.style.display = 'none';
        if (!username || !password) {
          errorMessage.textContent = '请输入用户名和密码';
          errorMessage.style.display = 'block';
          return;
        }
        try {
          const response = await fetch('/login', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ username, password })
          });
          if (response.ok) {
            successMessage.textContent = '登录成功，正在跳转...';
            successMessage.style.display = 'block';
            setTimeout(() => {
              window.location.href = redirectPath;
            }, 1000);
          } else {
            const data = await response.text();
            errorMessage.textContent = data || '用户名或密码错误';
            errorMessage.style.display = 'block';
          }
        } catch (error) {
          errorMessage.textContent = '登录请求失败，请稍后重试';
          errorMessage.style.display = 'block';
          console.error('登录错误:', error);
        }
      });
    </script>
  </body>
  </html>`;
}
function generateUploadPage(categoryOptions, storageType) {
  return `<!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <link rel="shortcut icon" href="https://tc-212.pages.dev/1744302340226.ico" type="image/x-icon">
    <meta name="description" content="Telegram文件存储与分享平台">
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>文件上传</title>
    <style>
      body {
        font-family: 'Segoe UI', Arial, sans-serif;
        margin: 0;
        padding: 0;
        min-height: 100vh;
        background: linear-gradient(135deg, #f0f4f8, #d9e2ec);
        display: flex;
        justify-content: center;
        align-items: center;
      }
      .container {
        max-width: 900px;
        width: 100%;
        background: rgba(255, 255, 255, 0.95);
        border-radius: 15px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.1);
        padding: 2rem;
        margin: 20px;
      }
      .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 1.5rem;
      }
      h1 {
        color: #2c3e50;
        margin: 0;
        font-size: 1.8rem;
        font-weight: 600;
      }
      .admin-link {
        color: #3498db;
        text-decoration: none;
        font-size: 1rem;
        transition: color 0.3s ease;
      }
      .admin-link:hover {
        color: #2980b9;
      }
      .options {
        display: flex;
        gap: 1rem;
        margin-bottom: 1.5rem;
        flex-wrap: wrap;
      }
      .category-select, .new-category input {
        padding: 0.8rem;
        border: 2px solid #dfe6e9;
        border-radius: 8px;
        font-size: 1rem;
        background: #fff;
        transition: border-color 0.3s ease, box-shadow 0.3s ease;
        box-shadow: 0 2px 5px rgba(0,0,0,0.05);
      }
      .category-select:focus, .new-category input:focus {
        outline: none;
        border-color: #3498db;
        box-shadow: 0 0 8px rgba(52,152,219,0.3);
      }
      .new-category {
        display: flex;
        gap: 1rem;
        align-items: center;
      }
      .new-category button {
        padding: 0.8rem 1.5rem;
        background: #2ecc71;
        color: white;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        transition: background 0.3s ease, transform 0.3s ease;
        box-shadow: 0 2px 5px rgba(0,0,0,0.1);
      }
      .new-category button:hover {
        background: #27ae60;
        transform: translateY(-2px);
      }
      .storage-toggle {
        display: flex;
        gap: 0.5rem;
      }
      .storage-btn {
        padding: 0.8rem 1.5rem;
        border: 2px solid #dfe6e9;
        border-radius: 8px;
        background: #fff;
        cursor: pointer;
        transition: all 0.3s ease;
        box-shadow: 0 2px 5px rgba(0,0,0,0.05);
      }
      .storage-btn.active {
        background: #3498db;
        color: white;
        border-color: #3498db;
      }
      .storage-btn:hover:not(.active) {
        background: #ecf0f1;
        transform: translateY(-2px);
      }
      .upload-area {
        border: 2px dashed #b2bec3;
        padding: 2rem;
        text-align: center;
        margin-bottom: 1.5rem;
        border-radius: 10px;
        background: #fff;
        transition: all 0.3s ease;
        box-shadow: 0 2px 10px rgba(0,0,0,0.05);
      }
      .upload-area.dragover {
        border-color: #3498db;
        background: #f8f9fa;
        box-shadow: 0 0 15px rgba(52,152,219,0.2);
      }
      .upload-area p {
        margin: 0;
        color: #7f8c8d;
        font-size: 1.1rem;
      }
      .preview-area {
        margin-top: 1rem;
      }
      .preview-item {
        display: flex;
        align-items: center;
        padding: 1rem;
        background: #fff;
        border-radius: 8px;
        margin-bottom: 1rem;
        box-shadow: 0 2px 5px rgba(0,0,0,0.05);
        transition: transform 0.3s ease;
      }
      .preview-item:hover {
        transform: translateY(-2px);
      }
      .preview-item img {
        max-width: 100px;
        max-height: 100px;
        margin-right: 1rem;
        border-radius: 5px;
      }
      .preview-item .info {
        flex-grow: 1;
        color: #2c3e50;
      }
      .progress-bar {
        height: 20px;
        background: #ecf0f1;
        border-radius: 10px;
        margin: 8px 0;
        overflow: hidden;
        position: relative;
      }
      .progress-track {
        height: 100%;
        background: #3498db;
        transition: width 0.3s ease;
        width: 0;
      }
      .progress-text {
        position: absolute;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        color: #fff;
        font-size: 12px;
      }
      .success .progress-track {
        background: #2ecc71;
      }
      .error .progress-track {
        background: #e74c3c;
      }
      .url-area {
        margin-top: 1.5rem;
      }
      .url-area textarea {
        width: 100%;
        min-height: 100px;
        padding: 0.8rem;
        border: 2px solid #dfe6e9;
        border-radius: 8px;
        background: #fff;
        font-size: 0.9rem;
        resize: vertical;
        transition: border-color 0.3s ease;
      }
      .url-area textarea:focus {
        outline: none;
        border-color: #3498db;
      }
      .button-group {
        margin-top: 1rem;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 1rem;
      }
      .button-container button {
        padding: 0.7rem 1.2rem;
        border: none;
        border-radius: 8px;
        background: #3498db;
        color: white;
        cursor: pointer;
        transition: background 0.3s ease, transform 0.3s ease;
        box-shadow: 0 2px 5px rgba(0,0,0,0.1);
      }
      .button-container button:hover {
        background: #2980b9;
        transform: translateY(-2px);
      }
      .copyright {
        font-size: 0.8rem;
        color: #7f8c8d;
      }
      .copyright a {
        color: #3498db;
        text-decoration: none;
      }
      .copyright a:hover {
        text-decoration: underline;
      }
      .modal {
        display: none;
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.7);
        justify-content: center;
        align-items: center;
        z-index: 1000;
        opacity: 0;
        transition: opacity 0.3s ease;
      }
      .modal.show {
        display: flex;
        opacity: 1;
      }
      .modal-content {
        background: white;
        padding: 2rem;
        border-radius: 15px;
        box-shadow: 0 15px 40px rgba(0,0,0,0.3);
        text-align: center;
        width: 90%;
        max-width: 400px;
        transform: scale(0.9);
        transition: transform 0.3s ease;
      }
      .modal.show .modal-content {
        transform: scale(1);
      }
      .modal-title {
        color: #2c3e50;
        font-size: 1.3rem;
        margin-top: 0;
        margin-bottom: 1rem;
      }
      .modal-message {
        margin-bottom: 1.5rem;
        color: #34495e;
        line-height: 1.5;
      }
      .modal-buttons {
        display: flex;
        gap: 1rem;
        justify-content: center;
      }
      .modal-button {
        padding: 0.8rem 1.8rem;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.3s ease;
        box-shadow: 0 2px 5px rgba(0,0,0,0.1);
        font-size: 0.95rem;
        font-weight: 500;
      }
      .modal-confirm {
        background: #3498db;
        color: white;
      }
      .modal-cancel {
        background: #95a5a6;
        color: white;
      }
      .modal-button:hover {
        transform: translateY(-2px);
        box-shadow: 0 4px 8px rgba(0,0,0,0.15);
      }
      .modal-confirm:hover {
        background: #2980b9;
      }
      .modal-cancel:hover {
        background: #7f8c8d;
      }
      @media (max-width: 768px) {
        body {
          padding: 10px;
          align-items: flex-start;
        }
        .container {
          padding: 1rem;
          margin: 10px;
        }
        .header {
          flex-direction: column;
          align-items: flex-start;
          gap: 10px;
        }
        .options {
          flex-direction: column;
          align-items: stretch;
        }
        .new-category {
           flex-direction: column;
           align-items: stretch;
           width: 100%;
        }
        .new-category input {
           width: auto;
        }
        .storage-toggle {
           justify-content: center;
        }
        .upload-area p {
           font-size: 1rem;
        }
        .button-group {
          flex-direction: column;
          align-items: stretch;
          gap: 0.5rem;
        }
        .button-container {
          display: flex;
          flex-wrap: wrap;
          gap: 0.5rem;
          justify-content: center;
        }
        .button-container button {
          flex-grow: 1;
        }
        .copyright {
           text-align: center;
           margin-top: 1rem;
        }
        .modal-content {
           padding: 1.5rem;
        }
      }
      @media (max-width: 480px) {
        .storage-btn {
           padding: 0.6rem 1rem;
           font-size: 0.9rem;
        }
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h1>文件上传</h1>
        <a href="/admin" class="admin-link">管理文件</a>
      </div>
      <div class="options">
        <select id="categorySelect" class="category-select">
          <option value="">选择分类</option>
          ${categoryOptions}
        </select>
        <div class="new-category">
          <input type="text" id="newCategoryInput" placeholder="输入新分类名称">
          <button onclick="createNewCategory()">新建分类</button>
        </div>
        <div class="storage-toggle">
          <button class="storage-btn ${storageType === 'telegram' ? 'active' : ''}" data-storage="telegram">Telegram</button>
          <button class="storage-btn ${storageType === 'r2' ? 'active' : ''}" data-storage="r2">R2</button>
        </div>
      </div>
      <div class="upload-area" id="uploadArea">
        <p>点击选择 或 拖拽文件到此处</p>
        <input type="file" id="fileInput" multiple style="display: none">
      </div>
      <div class="preview-area" id="previewArea"></div>
      <div class="url-area">
        <textarea id="urlArea" readonly placeholder="上传完成后的链接将显示在这里"></textarea>
        <div class="button-group">
          <div class="button-container">
            <button onclick="copyUrls('url')">复制URL</button>
            <button onclick="copyUrls('markdown')">复制Markdown</button>
            <button onclick="copyUrls('html')">复制HTML</button>
          </div>
          <div class="copyright">
            <span>© 2025 Copyright by <a href="https://github.com/iawooo/cftc" target="_blank">AWEI's GitHub</a> | <a href="https://awei.nyc.mn/" target="_blank">AWEI</a></span>
          </div>
        </div>
      </div>
      <!-- 通用确认弹窗 -->
      <div id="confirmModal" class="modal">
        <div class="modal-content">
          <h3 class="modal-title">提示</h3>
          <p class="modal-message" id="confirmModalMessage"></p>
          <div class="modal-buttons">
            <button class="modal-button modal-confirm" id="confirmModalConfirm">确认</button>
            <button class="modal-button modal-cancel" id="confirmModalCancel">取消</button>
          </div>
        </div>
      </div>
    </div>
    <script>
      async function setBingBackground() {
        try {
          const response = await fetch('/bing', { cache: 'no-store' });
          const data = await response.json();
          if (data.status && data.data && data.data.length > 0) {
            const randomIndex = Math.floor(Math.random() * data.data.length);
            document.body.style.backgroundImage = \`url(\${data.data[randomIndex].url})\`;
          }
        } catch (error) {
          console.error('获取背景图失败:', error);
        }
      }
      setBingBackground();
      setInterval(setBingBackground, 3600000);
      const uploadArea = document.getElementById('uploadArea');
      const fileInput = document.getElementById('fileInput');
      const previewArea = document.getElementById('previewArea');
      const urlArea = document.getElementById('urlArea');
      const categorySelect = document.getElementById('categorySelect');
      const newCategoryInput = document.getElementById('newCategoryInput');
      const storageButtons = document.querySelectorAll('.storage-btn');
      const confirmModal = document.getElementById('confirmModal');
      const confirmModalMessage = document.getElementById('confirmModalMessage');
      const confirmModalConfirm = document.getElementById('confirmModalConfirm');
      const confirmModalCancel = document.getElementById('confirmModalCancel');
      let uploadedUrls = [];
      let currentConfirmCallback = null;
      storageButtons.forEach(btn => {
        btn.addEventListener('click', () => {
          storageButtons.forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
        });
      });
      async function createNewCategory() {
        const categoryName = newCategoryInput.value.trim();
        if (!categoryName) {
          showConfirmModal('分类名称不能为空！', null, true);
          return;
        }
        try {
          const response = await fetch('/create-category', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: categoryName })
          });
          const data = await response.json();
          if (data.status === 1) {
            const option = document.createElement('option');
            option.value = data.category.id;
            option.textContent = data.category.name;
            categorySelect.appendChild(option);
            categorySelect.value = data.category.id;
            newCategoryInput.value = '';
            showConfirmModal(data.msg, null, true);
          } else {
            showConfirmModal(data.msg, null, true);
          }
        } catch (error) {
          showConfirmModal('创建分类失败：' + error.message, null, true);
        }
      }
      function showConfirmModal(message, callback, alertOnly = false) {
        closeConfirmModal();
        confirmModalMessage.textContent = message;
        currentConfirmCallback = callback;
        if (alertOnly) {
          confirmModalConfirm.textContent = '确定';
          confirmModalCancel.style.display = 'none';
        } else {
          confirmModalConfirm.textContent = '确认';
          confirmModalCancel.style.display = 'inline-block';
        }
        confirmModal.classList.add('show');
      }
      function closeConfirmModal() {
        confirmModal.classList.remove('show');
      }
      confirmModalConfirm.addEventListener('click', () => {
        if (currentConfirmCallback) {
          currentConfirmCallback();
        }
        closeConfirmModal();
      });
      confirmModalCancel.addEventListener('click', closeConfirmModal);
      window.addEventListener('click', (event) => {
        if (confirmModal && event.target === confirmModal) {
          closeConfirmModal();
        }
      });
      ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        uploadArea.addEventListener(eventName, preventDefaults, false);
        document.body.addEventListener(eventName, preventDefaults, false);
      });
      function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
      }
      ['dragenter', 'dragover'].forEach(eventName => {
        uploadArea.addEventListener(eventName, highlight, false);
      });
      ['dragleave', 'drop'].forEach(eventName => {
        uploadArea.addEventListener(eventName, unhighlight, false);
      });
      function highlight(e) {
        uploadArea.classList.add('dragover');
      }
      function unhighlight(e) {
        uploadArea.classList.remove('dragover');
      }
      uploadArea.addEventListener('drop', handleDrop, false);
      uploadArea.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', handleFiles);
      function handleDrop(e) {
        const dt = e.dataTransfer;
        const files = dt.files;
        handleFiles({ target: { files } });
      }
      document.addEventListener('paste', async (e) => {
        const items = (e.clipboardData || e.originalEvent.clipboardData).items;
        for (let item of items) {
          if (item.kind === 'file') {
            const file = item.getAsFile();
            await uploadFile(file);
          }
        }
      });
      async function handleFiles(e) {
        const response = await fetch('/config');
        if (!response.ok) {
          throw new Error('Failed to fetch config');
        }
        const config = await response.json();
        const files = Array.from(e.target.files);
        for (let file of files) {
          if (file.size > config.maxSizeMB * 1024 * 1024) {
            showConfirmModal(\`文件超过\${config.maxSizeMB}MB限制\`, null, true);
            return;
          }
          await uploadFile(file);
        }
      }
      function uploadFile(file) {
        return new Promise((resolve) => {
          const preview = createPreview(file);
          previewArea.appendChild(preview);
          const xhr = new XMLHttpRequest();
          const progressTrack = preview.querySelector('.progress-track');
          const progressText = preview.querySelector('.progress-text');
      
          xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
              const percent = Math.round((e.loaded / e.total) * 100);
              progressTrack.style.width = \`\${percent}%\`;
              progressText.textContent = \`\${percent}%\`;
            }
          });
      
          xhr.addEventListener('load', () => {
            try {
              const data = JSON.parse(xhr.responseText);
              const progressText = preview.querySelector('.progress-text');
              if (xhr.status >= 200 && xhr.status < 300 && data.status === 1) {
                progressText.textContent = data.msg;
                uploadedUrls.push(data.url);
                updateUrlArea();
                preview.classList.add('success');
              } else {
                const errorMsg = [data.msg, data.error || '未知错误'].filter(Boolean).join(' | ');
                progressText.textContent = errorMsg;
                preview.classList.add('error');
              }
            } catch (e) {
              preview.querySelector('.progress-text').textContent = '✗ 响应解析失败';
              preview.classList.add('error');
            }
            resolve();          // ← 关键：上传"结束"(无论成功失败)才 resolve
          });
      
          xhr.addEventListener('error', () => {
            preview.querySelector('.progress-text').textContent = '✗ 网络错误';
            preview.classList.add('error');
            resolve();          // ← 网络异常也要 resolve，否则整个队列会卡死
          });
      
          const formData = new FormData();
          formData.append('file', file);
          formData.append('category', categorySelect.value);
          formData.append('storage_type', document.querySelector('.storage-btn.active').dataset.storage);
          xhr.open('POST', '/upload');
          xhr.send(formData);
        });
      }
      function createPreview(file) {
        const div = document.createElement('div');
        div.className = 'preview-item';
        if (file.type.startsWith('image/')) {
          const img = document.createElement('img');
          img.src = URL.createObjectURL(file);
          div.appendChild(img);
        }
        const info = document.createElement('div');
        info.className = 'info';
        info.innerHTML = \`
          <div>\${file.name}</div>
          <div>\${formatSize(file.size)}</div>
          <div class="progress-bar">
            <div class="progress-track"></div>
            <span class="progress-text">0%</span>
          </div>
        \`;
        div.appendChild(info);
        return div;
      }
      function formatSize(bytes) {
        const units = ['B', 'KB', 'MB', 'GB'];
        let size = bytes;
        let unitIndex = 0;
        while (size >= 1024 && unitIndex < units.length - 1) {
          size /= 1024;
          unitIndex++;
        }
        return \`\${size.toFixed(2)} \${units[unitIndex]}\`;
      }
      function updateUrlArea() {
        urlArea.value = uploadedUrls.join('\\n');
      }
      function copyUrls(format) {
        let text = '';
        switch (format) {
          case 'url':
            text = uploadedUrls.join('\\n');
            break;
          case 'markdown':
            text = uploadedUrls.map(url => \`![](\${url})\`).join('\\n');
            break;
          case 'html':
            text = uploadedUrls.map(url => \`<img src="\${url}" />\`).join('\\n');
            break;
        }
        navigator.clipboard.writeText(text)
          .then(() => {
            showConfirmModal('已复制到剪贴板', null, true);
          })
          .catch(() => {
            showConfirmModal('复制失败，请手动复制', null, true);
          });
      }
    </script>
  </body>
  </html>`;
}
function generateUserManagementPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  >
  <title>用户管理</title>

  <style>
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      padding: 20px;
      min-height: 100vh;
      font-family: Arial, "Microsoft YaHei", sans-serif;
      background: linear-gradient(135deg, #f0f4f8, #d9e2ec);
      color: #2c3e50;
    }

    .container {
      max-width: 1000px;
      margin: 0 auto;
    }

    .header,
    .panel {
      background: rgba(255, 255, 255, 0.96);
      border-radius: 14px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
      padding: 22px;
      margin-bottom: 20px;
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 15px;
    }

    h1,
    h2 {
      margin-top: 0;
    }

    h1 {
      margin-bottom: 0;
      font-size: 28px;
    }

    h2 {
      font-size: 20px;
      margin-bottom: 16px;
    }

    .back-button {
      display: inline-block;
      padding: 10px 16px;
      border-radius: 8px;
      text-decoration: none;
      color: white;
      background: #3498db;
    }

    .add-form {
      display: flex;
      gap: 12px;
    }

    .add-form input {
      flex: 1;
      min-width: 0;
      padding: 12px;
      border: 2px solid #dfe6e9;
      border-radius: 8px;
      font-size: 16px;
    }

    .add-form input:focus {
      outline: none;
      border-color: #3498db;
    }

    button {
      border: 0;
      border-radius: 8px;
      padding: 11px 18px;
      cursor: pointer;
      font-size: 15px;
      font-weight: 600;
    }

    .add-button {
      color: white;
      background: #27ae60;
    }

    .delete-button {
      color: white;
      background: #e74c3c;
    }

    .refresh-button {
      color: white;
      background: #7f8c8d;
    }

    .message {
      display: none;
      margin-top: 14px;
      padding: 12px;
      border-radius: 8px;
    }

    .message.success {
      display: block;
      background: #eafaf1;
      color: #1e8449;
    }

    .message.error {
      display: block;
      background: #fdecea;
      color: #c0392b;
    }

    .admin-list {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }

    .admin-item {
      padding: 10px 14px;
      border-radius: 8px;
      background: #f3e5f5;
      color: #7d3c98;
      font-weight: 600;
    }

    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 15px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    th,
    td {
      padding: 12px;
      border-bottom: 1px solid #ecf0f1;
      text-align: left;
      word-break: break-all;
    }

    th {
      background: #f8f9fa;
    }

    .empty {
      padding: 20px;
      text-align: center;
      color: #7f8c8d;
    }

    .hint {
      color: #7f8c8d;
      font-size: 14px;
      line-height: 1.7;
    }

    @media (max-width: 700px) {
      body {
        padding: 10px;
      }

      .header {
        flex-direction: column;
        align-items: stretch;
      }

      .back-button {
        text-align: center;
      }

      .add-form {
        flex-direction: column;
      }

      .toolbar {
        flex-direction: column;
        align-items: stretch;
      }

      .refresh-button {
        width: 100%;
      }

      table,
      thead,
      tbody,
      tr,
      th,
      td {
        display: block;
      }

      thead {
        display: none;
      }

      tr {
        padding: 12px;
        margin-bottom: 12px;
        border: 1px solid #ecf0f1;
        border-radius: 8px;
      }

      td {
        border-bottom: 0;
        padding: 7px 0;
      }
    }
  </style>
</head>

<body>
  <div class="container">
    <div class="header">
      <h1>用户管理</h1>
      <a href="/admin" class="back-button">
        返回文件管理
      </a>
    </div>

    <div class="panel">
      <h2>添加用户</h2>

      <div class="add-form">
        <input
          type="text"
          id="chatIdInput"
          inputmode="numeric"
          placeholder="输入 Telegram 用户 ID，例如 123456789"
        >

        <button
          type="button"
          class="add-button"
          id="addUserButton"
        >
          添加用户
        </button>
      </div>

      <div id="messageBox" class="message"></div>

      <p class="hint">
        只填写 Telegram 用户 ID，不要填写用户名或 @username。
        TG_ADMIN_ID 管理员无需重复添加。
      </p>
    </div>

    <div class="panel">
      <h2>TG_ADMIN_ID 管理员</h2>
      <div id="adminList" class="admin-list"></div>
    </div>

    <div class="panel">
      <div class="toolbar">
        <h2 style="margin:0;">
          普通授权用户
        </h2>

        <button
          type="button"
          class="refresh-button"
          id="refreshButton"
        >
          刷新列表
        </button>
      </div>

      <div id="userTableContainer">
        <div class="empty">正在加载……</div>
      </div>
    </div>
  </div>

  <script>
    const chatIdInput =
      document.getElementById('chatIdInput');

    const addUserButton =
      document.getElementById('addUserButton');

    const refreshButton =
      document.getElementById('refreshButton');

    const messageBox =
      document.getElementById('messageBox');

    const adminList =
      document.getElementById('adminList');

    const userTableContainer =
      document.getElementById('userTableContainer');

    function showMessage(text, type) {
      messageBox.textContent = text;
      messageBox.className =
        'message ' + (type || 'success');
    }

    function formatTime(timestamp) {
      const value = Number(timestamp || 0);

      if (!value) {
        return '-';
      }

      return new Date(value).toLocaleString('zh-CN');
    }

    async function parseResponse(response) {
      let data = null;

      try {
        data = await response.json();
      } catch (error) {
        throw new Error('服务器返回格式错误');
      }

      if (!response.ok || !data || data.status !== 1) {
        throw new Error(
          data && (data.error || data.message)
            ? (data.error || data.message)
            : '请求失败'
        );
      }

      return data;
    }

    function renderAdmins(admins) {
      adminList.innerHTML = '';

      if (!admins || admins.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = '尚未配置 TG_ADMIN_ID';
        adminList.appendChild(empty);
        return;
      }

      admins.forEach(function(adminId) {
        const item = document.createElement('div');
        item.className = 'admin-item';
        item.textContent = adminId;
        adminList.appendChild(item);
      });
    }

    function renderUsers(users) {
      userTableContainer.innerHTML = '';

      if (!users || users.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = '当前没有普通授权用户';
        userTableContainer.appendChild(empty);
        return;
      }

      const table = document.createElement('table');
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');

      [
        'Telegram 用户 ID',
        '添加来源',
        '添加时间',
        '操作'
      ].forEach(function(title) {
        const th = document.createElement('th');
        th.textContent = title;
        headRow.appendChild(th);
      });

      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');

      users.forEach(function(user) {
        const row = document.createElement('tr');

        const idCell = document.createElement('td');
        idCell.textContent = user.chat_id || '-';

        const sourceCell = document.createElement('td');
        sourceCell.textContent = user.added_by || '-';

        const timeCell = document.createElement('td');
        timeCell.textContent = formatTime(user.created_at);

        const actionCell = document.createElement('td');
        const deleteButton = document.createElement('button');

        deleteButton.type = 'button';
        deleteButton.className = 'delete-button';
        deleteButton.textContent = '删除';

        deleteButton.addEventListener('click', function() {
          deleteUser(user.chat_id);
        });

        actionCell.appendChild(deleteButton);

        row.appendChild(idCell);
        row.appendChild(sourceCell);
        row.appendChild(timeCell);
        row.appendChild(actionCell);

        tbody.appendChild(row);
      });

      table.appendChild(tbody);
      userTableContainer.appendChild(table);
    }

    async function loadUsers() {
      userTableContainer.innerHTML =
        '<div class="empty">正在加载……</div>';

      try {
        const response = await fetch('/api/users', {
          method: 'GET',
          headers: {
            'Accept': 'application/json'
          },
          cache: 'no-store'
        });

        const data = await parseResponse(response);

        renderAdmins(data.admins || []);
        renderUsers(data.users || []);
      } catch (error) {
        userTableContainer.innerHTML = '';

        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent =
          '加载失败：' + error.message;

        userTableContainer.appendChild(empty);
      }
    }

    async function addUser() {
      const chatId = chatIdInput.value.trim();

      if (!/^\\d{5,20}$/.test(chatId)) {
        showMessage(
          '请输入正确的纯数字 Telegram 用户 ID',
          'error'
        );
        return;
      }

      addUserButton.disabled = true;

      try {
        const response = await fetch('/api/users/add', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            chat_id: chatId
          })
        });

        const data = await parseResponse(response);

        showMessage(
          data.message || '用户添加成功',
          'success'
        );

        chatIdInput.value = '';

        await loadUsers();
      } catch (error) {
        showMessage(
          '添加失败：' + error.message,
          'error'
        );
      } finally {
        addUserButton.disabled = false;
      }
    }

    async function deleteUser(chatId) {
      const confirmed = window.confirm(
        '确定取消用户 ' + chatId + ' 的使用权限吗？\\n\\n' +
        '该操作不会删除用户已经上传的文件。'
      );

      if (!confirmed) {
        return;
      }

      try {
        const response = await fetch('/api/users/delete', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            chat_id: chatId
          })
        });

        const data = await parseResponse(response);

        showMessage(
          data.message || '用户权限已删除',
          'success'
        );

        await loadUsers();
      } catch (error) {
        showMessage(
          '删除失败：' + error.message,
          'error'
        );
      }
    }

    addUserButton.addEventListener(
      'click',
      addUser
    );

    chatIdInput.addEventListener(
      'keydown',
      function(event) {
        if (event.key === 'Enter') {
          addUser();
        }
      }
    );

    refreshButton.addEventListener(
      'click',
      loadUsers
    );

    loadUsers();
  </script>
</body>
</html>`;
}
function generateAdminPage(fileCards, categoryOptions) {
  return `<!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <link rel="shortcut icon" href="https://tc-212.pages.dev/1744302340226.ico" type="image/x-icon">
    <meta name="description" content="Telegram文件存储与分享平台">
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>文件管理</title>
    <!-- 确保QR码库在页面加载前就可用 -->
    <script src="https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js"></script>
    <style>
      body {
        font-family: 'Segoe UI', Arial, sans-serif;
        margin: 0;
        padding: 20px;
        min-height: 100vh;
        background: linear-gradient(135deg, #f0f4f8, #d9e2ec);
      }
      .container {
        max-width: 1200px;
        margin: 0 auto;
      }
      .header {
        background: rgba(255, 255, 255, 0.95);
        padding: 1.5rem;
        border-radius: 15px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.1);
        margin-bottom: 1.5rem;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      h2 {
        color: #2c3e50;
        margin: 0;
        font-size: 1.8rem;
      }
      .right-content {
        display: flex;
        gap: 1rem;
        align-items: center;
      }
      .search, .category-filter {
        padding: 0.7rem;
        border: 2px solid #dfe6e9;
        border-radius: 8px;
        font-size: 0.9rem;
        background: #fff;
        transition: border-color 0.3s ease;
        box-shadow: 0 2px 5px rgba(0,0,0,0.05);
      }
      .search:focus, .category-filter:focus {
        outline: none;
        border-color: #3498db;
      }
      .backup {
        color: #3498db;
        text-decoration: none;
        font-size: 1rem;
        transition: color 0.3s ease;
      }
      .backup:hover {
        color: #2980b9;
      }
      .return-btn {
        background: #2ecc71;
        color: white;
        padding: 0.7rem 1.5rem;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        font-size: 0.9rem;
        transition: all 0.3s ease;
        text-decoration: none;
        margin-left: 10px;
      }
      .return-btn:hover {
        background: #27ae60;
        transform: translateY(-2px);
      }
      .action-bar {
        background: rgba(255, 255, 255, 0.95);
        padding: 1.5rem;
        border-radius: 15px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.1);
        margin-bottom: 1.5rem;
        display: flex;
        gap: 1rem;
        align-items: center;
        justify-content: space-between;
      }
      .action-bar-left {
        display: flex;
        gap: 1rem;
        align-items: center;
      }
      .action-bar-right {
        display: flex;
        gap: 1rem;
        align-items: center;
      }
      .action-bar h3 {
        margin: 0;
        color: #2c3e50;
        font-size: 1.2rem;
      }
      .action-bar select {
        padding: 0.7rem;
        border: 2px solid #dfe6e9;
        border-radius: 8px;
        font-size: 0.9rem;
        background: #fff;
        transition: border-color 0.3s ease;
      }
      .action-bar select:focus {
        outline: none;
        border-color: #3498db;
      }
      .action-button {
        padding: 0.7rem 1.5rem;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.3s ease;
        box-shadow: 0 2px 5px rgba(0,0,0,0.1);
        font-size: 0.9rem;
      }
      .select-all-btn {
        background: #3498db;
        color: white;
      }
      .delete-files-btn {
        background: #e74c3c;
        color: white;
      }
      .delete-category-btn {
        background: #e74c3c;
        color: white;
      }
      .action-button:hover {
        transform: translateY(-2px);
        box-shadow: 0 4px 8px rgba(0,0,0,0.15);
      }
      .select-all-btn:hover {
        background: #2980b9;
      }
      .delete-files-btn:hover {
        background: #c0392b;
      }
      .delete-category-btn:hover {
        background: #c0392b;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
        gap: 1.5rem;
      }
      .file-card {
        background: rgba(255, 255, 255, 0.95);
        border-radius: 15px;
        box-shadow: 0 5px 15px rgba(0,0,0,0.1);
        overflow: hidden;
        position: relative;
        transition: all 0.3s ease;
        cursor: pointer;
      }
      .file-card:hover {
        transform: translateY(-5px);
        box-shadow: 0 8px 20px rgba(0,0,0,0.15);
      }
      .file-card.selected {
        border: 3px solid #3498db;
      }
      .file-checkbox {
        position: absolute;
        top: 10px;
        left: 10px;
        z-index: 5;
        width: 20px;
        height: 20px;
      }
      .file-preview {
        height: 150px;
        background: #f8f9fa;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .file-preview img, .file-preview video {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
      }
      .file-info {
        padding: 1rem;
        font-size: 0.9rem;
        color: #2c3e50;
      }
      .file-actions {
        padding: 1rem;
        border-top: 1px solid #eee;
        display: flex;
        justify-content: space-between;
        gap: 0.5rem;
      }
      .btn {
        padding: 0.5rem 1rem;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.3s ease;
        box-shadow: 0 2px 5px rgba(0,0,0,0.1);
        font-size: 0.9rem;
        display: inline-block;
        text-align: center;
      }
      .btn-share {
        background: #3498db;
        color: white;
        flex: 1;
      }
      .btn-down {
        background: #2ecc71;
        color: white;
        text-decoration: none;
        flex: 1;
      }
      .btn-delete {
        background: #e74c3c;
        color: white;
        flex: 1;
      }
      .btn-edit {
        background: #f39c12;
        color: white;
        flex: 1;
      }
      .btn:hover {
        transform: translateY(-2px);
        box-shadow: 0 4px 8px rgba(0,0,0,0.15);
      }
      .btn-share:hover {
        background: #2980b9;
      }
      .btn-down:hover {
        background: #27ae60;
      }
      .btn-delete:hover {
        background: #c0392b;
      }
      .btn-edit:hover {
        background: #e67e22;
      }
      .modal {
        display: none;
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.7);
        justify-content: center;
        align-items: center;
        z-index: 1000;
        opacity: 0;
        transition: opacity 0.3s ease;
      }
      .modal.show {
        display: flex;
        opacity: 1;
      }
      .modal-content {
        background: white;
        padding: 2rem;
        border-radius: 15px;
        box-shadow: 0 15px 40px rgba(0,0,0,0.3);
        text-align: center;
        width: 90%;
        max-width: 400px;
        transform: scale(0.9);
        transition: transform 0.3s ease;
      }
      .modal.show .modal-content {
        transform: scale(1);
      }
      .modal-title {
        color: #2c3e50;
        font-size: 1.3rem;
        margin-top: 0;
        margin-bottom: 1rem;
      }
      .modal-message {
        margin-bottom: 1.5rem;
        color: #34495e;
        line-height: 1.5;
      }
      .modal-buttons {
        display: flex;
        gap: 1rem;
        justify-content: center;
      }
      .modal-button {
        padding: 0.8rem 1.8rem;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.3s ease;
        box-shadow: 0 2px 5px rgba(0,0,0,0.1);
        font-size: 0.95rem;
        font-weight: 500;
      }
      .modal-confirm {
        background: #3498db;
        color: white;
      }
      .modal-cancel {
        background: #95a5a6;
        color: white;
      }
      .modal-button:hover {
        transform: translateY(-2px);
        box-shadow: 0 4px 8px rgba(0,0,0,0.15);
      }
      .modal-confirm:hover {
        background: #2980b9;
      }
      .modal-cancel:hover {
        background: #7f8c8d;
      }
      #qrModal {
        display: none;
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.7);
        justify-content: center;
        align-items: center;
        z-index: 1000;
        opacity: 0;
        transition: opacity 0.3s ease;
      }
      #qrModal.show {
        display: flex;
        opacity: 1;
      }
      .qr-content {
        background: white;
        padding: 2rem;
        border-radius: 15px;
        box-shadow: 0 15px 40px rgba(0,0,0,0.3);
        text-align: center;
        width: 90%;
        max-width: 350px;
        transform: scale(0.9);
        transition: transform 0.3s ease;
      }
      #qrModal.show .qr-content {
        transform: scale(1);
      }
      .qr-title {
        color: #2c3e50;
        font-size: 1.3rem;
        margin-top: 0;
        margin-bottom: 0.5rem;
      }
      .qr-file-name {
        color: #7f8c8d;
        font-size: 0.9rem;
        margin-bottom: 1rem;
        word-break: break-all;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #qrcode {
        margin: 1.5rem auto;
      }
      .qr-buttons {
        display: flex;
        gap: 0.5rem;
        justify-content: center;
        margin-top: 1.5rem;
      }
      .qr-copy, .qr-download, .qr-close {
        padding: 0.8rem 1rem;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.3s ease;
        box-shadow: 0 2px 5px rgba(0,0,0,0.1);
        font-size: 0.9rem;
        font-weight: 500;
        text-decoration: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .qr-copy {
        background: #3498db;
        color: white;
      }
      .qr-download {
        background: #2ecc71;
        color: white;
      }
      .qr-close {
        background: #95a5a6;
        color: white;
      }
      .qr-copy:hover, .qr-download:hover, .qr-close:hover {
        transform: translateY(-2px);
        box-shadow: 0 4px 8px rgba(0,0,0,0.15);
      }
      .qr-copy:hover {
        background: #2980b9;
      }
      .qr-download:hover {
        background: #27ae60;
      }
      .qr-close:hover {
        background: #7f8c8d;
      }
      #editSuffixModal {
        display: none;
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.7);
        justify-content: center;
        align-items: center;
        z-index: 1000;
      }
      #editSuffixModal.show {
        display: flex;
      }
      #editSuffixModal .modal-content {
        background: white;
        padding: 2rem;
        border-radius: 15px;
        box-shadow: 0 15px 40px rgba(0,0,0,0.3);
        text-align: center;
        width: 90%;
        max-width: 400px;
      }
      #editSuffixModal input {
        width: 100%;
        padding: 0.8rem;
        margin: 1rem 0;
        border: 2px solid #dfe6e9;
        border-radius: 8px;
        font-size: 1rem;
      }
      @media (max-width: 768px) {
        body {
          padding: 10px;
        }
        .container {
          padding: 1rem;
        }
        .header {
          flex-direction: column;
          align-items: flex-start;
          gap: 10px;
        }
        .header .right-content {
          flex-direction: column;
          width: 100%;
          gap: 10px;
          align-items: stretch;
        }
        .header input.search,
        .header select.category-filter,
        .header a.return-btn {
          width: 100%;
          box-sizing: border-box;
          margin-left: 0;
          text-align: center;
        }
        .action-bar {
          flex-direction: column;
          align-items: stretch;
          gap: 1rem;
        }
        .action-bar-left,
        .action-bar-right {
          flex-direction: column;
          align-items: stretch;
          gap: 10px;
          width: 100%;
        }
        .action-bar h3 {
          text-align: center;
        }
        .grid {
          grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
          gap: 1rem;
        }
        .file-card {
          border-radius: 10px;
        }
        .file-info {
           padding: 0.8rem;
           font-size: 0.85rem;
        }
        .file-actions {
           padding: 0.8rem;
           gap: 5px;
           flex-wrap: wrap;
        }
        .btn {
           padding: 0.6rem 0.8rem;
           font-size: 0.8rem;
           flex-grow: 1;
           min-width: 80px;
        }
      }
      @media (max-width: 480px) {
         .grid {
            grid-template-columns: 1fr;
         }
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h2>文件管理</h2>
        <div class="right-content">
          <input type="text" id="search-input" name="searchInput" class="search" placeholder="搜索文件名...">
          <select id="category-filter" name="categoryFilter" class="category-filter">
            <option value="">所有分类</option>
            ${categoryOptions}
          </select>
          
          <a
            href="/users"
            class="return-btn"
            style="background:#8e44ad;"
          >
            用户管理
          </a>
          
          <a href="/upload" class="return-btn">
            返回上传
          </a>
        </div>
      </div>
      <div class="action-bar">
        <div class="action-bar-left">
          <h3>文件操作：</h3>
          <button class="action-button select-all-btn" id="selectAllBtn">全选/取消</button>
          <button class="action-button delete-files-btn" id="deleteFilesBtn">删除选中</button>
        </div>
        <div class="action-bar-right">
          <h3>分类管理：</h3>
          <select id="categoryDeleteSelect" name="categoryDeleteSelect" class="category-filter">
            ${categoryOptions}
          </select>
          <button class="action-button delete-category-btn" id="deleteCategoryBtn">删除分类</button>
        </div>
      </div>
      <div class="grid" id="fileGrid">
        ${fileCards}
      </div>
      <!-- 确认删除弹窗 -->
      <div id="confirmModal" class="modal">
        <div class="modal-content">
          <h3 class="modal-title">确认操作</h3>
          <p class="modal-message" id="confirmModalMessage"></p>
          <div class="modal-buttons">
            <button class="modal-button modal-confirm" id="confirmModalConfirm">确认</button>
            <button class="modal-button modal-cancel" id="confirmModalCancel">取消</button>
          </div>
        </div>
      </div>
      <!-- 修改后缀弹窗 -->
      <div id="editSuffixModal" class="modal">
        <div class="modal-content">
          <h3 class="modal-title">修改文件后缀</h3>
          <input type="text" id="editSuffixInput" name="editSuffixInput" placeholder="输入新的文件后缀">
          <div class="modal-buttons">
            <button class="modal-button modal-confirm" id="editSuffixConfirm">确认</button>
            <button class="modal-button modal-cancel" id="editSuffixCancel">取消</button>
          </div>
        </div>
      </div>
    </div>
    <script>
      let currentShareUrl = '';
      let currentConfirmCallback = null;
      let currentEditUrl = '';
      let confirmModal, confirmModalMessage, confirmModalConfirm, confirmModalCancel, editSuffixModal, qrModal, qrCopyBtn, qrDownloadBtn, qrCloseBtn;
      async function setBingBackground() {
        try {
          const response = await fetch('/bing', { cache: 'no-store' });
          const data = await response.json();
          if (data.status && data.data && data.data.length > 0) {
            const randomIndex = Math.floor(Math.random() * data.data.length);
            document.body.style.backgroundImage = \`url(\${data.data[randomIndex].url})\`;
          }
        } catch (error) {
          console.error('获取背景图失败:', error);
        }
      }
      setTimeout(setBingBackground, 1000);
      document.addEventListener('DOMContentLoaded', function() {
        console.log('DOM已加载，初始化页面...');
        confirmModal = document.getElementById('confirmModal');
        confirmModalMessage = document.getElementById('confirmModalMessage');
        confirmModalConfirm = document.getElementById('confirmModalConfirm');
        confirmModalCancel = document.getElementById('confirmModalCancel');
        editSuffixModal = document.getElementById('editSuffixModal');
        qrModal = document.getElementById('qrModal');
        qrCopyBtn = document.getElementById('qrCopyBtn');
        qrDownloadBtn = document.getElementById('qrDownloadBtn');
        qrCloseBtn = document.getElementById('qrCloseBtn');
        const searchInput = document.getElementById('search-input');
        const categoryFilter = document.getElementById('category-filter');
        const selectAllBtn = document.getElementById('selectAllBtn');
        const deleteFilesBtn = document.getElementById('deleteFilesBtn');
        const deleteCategoryBtn = document.getElementById('deleteCategoryBtn');
        const editSuffixConfirm = document.getElementById('editSuffixConfirm');
        const editSuffixCancel = document.getElementById('editSuffixCancel');
        console.log('页面元素引用:', {
          confirmModal: !!confirmModal,
          editSuffixModal: !!editSuffixModal,
          qrModal: !!qrModal
        });
        if (searchInput) searchInput.addEventListener('input', filterFiles);
        if (categoryFilter) categoryFilter.addEventListener('change', filterFiles);
        if (selectAllBtn) selectAllBtn.addEventListener('click', toggleSelectAll);
        if (deleteFilesBtn) deleteFilesBtn.addEventListener('click', confirmDeleteSelected);
        if (deleteCategoryBtn) deleteCategoryBtn.addEventListener('click', confirmDeleteCategory);
        if (confirmModalConfirm) confirmModalConfirm.addEventListener('click', handleConfirmModalConfirm);
        if (confirmModalCancel) confirmModalCancel.addEventListener('click', closeConfirmModal);
        if (editSuffixCancel) editSuffixCancel.addEventListener('click', function() {
          if (editSuffixModal) editSuffixModal.classList.remove('show');
        });
        if (editSuffixConfirm) editSuffixConfirm.addEventListener('click', updateFileSuffix);
        if (qrCopyBtn) qrCopyBtn.addEventListener('click', copyCurrentShareUrl);
        if (qrDownloadBtn) { }
        if (qrCloseBtn) qrCloseBtn.addEventListener('click', closeQrModal);
        window.addEventListener('click', handleWindowClick);
        initializeFileCards();
      });
      function initializeFileCards() {
        const fileGrid = document.getElementById('fileGrid');
        if (!fileGrid) return;
        const fileCards = Array.from(fileGrid.children);
        fileCards.forEach(card => {
          const checkbox = card.querySelector('.file-checkbox');
          if (!checkbox) return;
          card.addEventListener('click', (e) => {
            if (e.target === checkbox || 
                e.target.closest('.file-actions a') || 
                e.target.closest('.file-actions button')) {
              return; 
            }
            checkbox.checked = !checkbox.checked;
            const changeEvent = new Event('change', { bubbles: true });
            checkbox.dispatchEvent(changeEvent);
          });
          checkbox.addEventListener('change', () => {
            card.classList.toggle('selected', checkbox.checked);
          });
           card.classList.toggle('selected', checkbox.checked);
        });
      }
      function filterFiles() {
        const searchInput = document.getElementById('search-input');
        const categoryFilter = document.getElementById('category-filter');
        const fileGrid = document.getElementById('fileGrid');
        if (!searchInput || !categoryFilter || !fileGrid) return;
        const searchTerm = searchInput.value.toLowerCase();
        const selectedCategory = categoryFilter.value;
        const fileCards = Array.from(fileGrid.children);
        fileCards.forEach(card => {
          const fileInfo = card.querySelector('.file-info');
          if (!fileInfo) return;
          const fileName = fileInfo.querySelector('div:first-child')?.textContent.toLowerCase() || '';
          const categoryId = card.getAttribute('data-category-id') || '';
          const matchesSearch = fileName.includes(searchTerm);
          const matchesCategory = selectedCategory === '' || categoryId === selectedCategory;
          card.style.display = matchesSearch && matchesCategory ? '' : 'none';
        });
      }
      function toggleSelectAll() {
        const fileGrid = document.getElementById('fileGrid');
        if (!fileGrid) return;
        const fileCards = Array.from(fileGrid.children);
        const visibleCards = fileCards.filter(card => card.style.display !== 'none');
        const allSelected = visibleCards.every(card => card.querySelector('.file-checkbox')?.checked);
        visibleCards.forEach(card => {
          const checkbox = card.querySelector('.file-checkbox');
          if (checkbox) {
            checkbox.checked = !allSelected;
            card.classList.toggle('selected', !allSelected);
          }
        });
      }
      function confirmDeleteSelected() {
        const selectedCheckboxes = document.querySelectorAll('.file-checkbox:checked');
        if (selectedCheckboxes.length === 0) {
          showConfirmModal('请先选择要删除的文件！', null, true);
          return;
        }
        showConfirmModal(
          \`确定要删除选中的 \${selectedCheckboxes.length} 个文件吗？\`, 
          deleteSelectedFiles
        );
      }
      function confirmDeleteCategory() {
        const select = document.getElementById('categoryDeleteSelect');
        if (!select) return;
        const categoryId = select.value;
        if (!categoryId) {
          showConfirmModal('请选择要删除的分类', null, true);
          return;
        }
        const categoryName = select.options[select.selectedIndex].text;
        showConfirmModal(
          \`确定要删除分类 "\${categoryName}" 吗？这将清空所有关联文件的分类！\`, 
          deleteCategory
        );
      }
      function shareFile(url, fileName) {
        console.log('分享文件:', url);
        try {
          const modal = document.createElement('div');
          modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:1000;display:flex;justify-content:center;align-items:center;';
          const content = document.createElement('div');
          content.style.cssText = 'background:white;padding:20px;border-radius:10px;max-width:90%;width:350px;text-align:center;';
          const title = document.createElement('h3');
          title.style.cssText = 'margin-top:0;color:#333;';
          title.textContent = '分享文件';
          const fileNameElem = document.createElement('div');
          fileNameElem.style.cssText = 'margin-bottom:10px;word-break:break-all;font-size:14px;color:#666;';
          fileNameElem.textContent = fileName || getFileName(url);
          const qrContainer = document.createElement('div');
          qrContainer.id = 'qrcode-container';
          qrContainer.style.cssText = 'margin:20px auto;height:200px;width:200px;';
          try {
            const qrcode = new QRCode(qrContainer, {
              text: url,
              width: 200,
              height: 200,
              colorDark: "#000000",
              colorLight: "#ffffff",
              correctLevel: QRCode.CorrectLevel.H
            });
          } catch (qrError) {
            console.error('二维码生成失败:', qrError);
            qrContainer.innerHTML = '<div style="padding:20px;word-break:break-all;border:1px dashed #ccc;">' + url + '</div>';
          }
          const buttons = document.createElement('div');
          buttons.style.cssText = 'display:flex;gap:10px;justify-content:center;margin-top:20px;';
          const copyBtn = document.createElement('button');
          copyBtn.id = 'copy-link-btn';
          copyBtn.style.cssText = 'flex:1;padding:8px 15px;border:none;border-radius:4px;background:#3498db;color:white;cursor:pointer;';
          copyBtn.textContent = '复制';
          copyBtn.onclick = function() {
            navigator.clipboard.writeText(url)
              .then(() => {
                copyBtn.textContent = '已复制';
                setTimeout(() => { copyBtn.textContent = '复制'; }, 2000);
              })
              .catch(() => {
                prompt('请手动复制链接:', url);
              });
          };
          const downloadBtn = document.createElement('a');
          downloadBtn.id = 'download-file-btn';
          downloadBtn.style.cssText = 'flex:1;padding:8px 15px;border:none;border-radius:4px;background:#2ecc71;color:white;cursor:pointer;text-decoration:none;display:inline-block;text-align:center;';
          downloadBtn.textContent = '下载';
          downloadBtn.href = url;
          downloadBtn.setAttribute('download', fileName || getFileName(url));
          const cancelBtn = document.createElement('button');
          cancelBtn.id = 'close-share-btn';
          cancelBtn.style.cssText = 'flex:1;padding:8px 15px;border:none;border-radius:4px;background:#95a5a6;color:white;cursor:pointer;';
          cancelBtn.textContent = '取消';
          cancelBtn.onclick = function() {
            document.body.removeChild(modal);
          };
          buttons.appendChild(copyBtn);
          buttons.appendChild(downloadBtn);
          buttons.appendChild(cancelBtn);
          content.appendChild(title);
          content.appendChild(fileNameElem);
          content.appendChild(qrContainer);
          content.appendChild(buttons);
          modal.appendChild(content);
          modal.addEventListener('click', function(e) {
            if (e.target === modal) {
              document.body.removeChild(modal);
            }
          });
          document.body.appendChild(modal);
        } catch (error) {
          console.error('分享功能出错:', error);
          try {
            navigator.clipboard.writeText(url)
              .then(() => alert('链接已复制: ' + url))
              .catch(() => prompt('请复制链接:', url));
          } catch (e) {
            prompt('请复制链接:', url);
          }
        }
      }
      function closeQrModal() {
        if (qrModal) qrModal.style.display = 'none';
      }
      function copyCurrentShareUrl() {
        if (!currentShareUrl) return;
        navigator.clipboard.writeText(currentShareUrl)
          .then(() => {
            if (qrCopyBtn) {
              qrCopyBtn.textContent = '✓ 已复制';
              setTimeout(() => {
                qrCopyBtn.textContent = '复制链接';
              }, 2000);
            }
          })
          .catch(() => {
            prompt('请手动复制链接:', currentShareUrl);
          });
      }
      function showConfirmModal(message, callback, alertOnly = false) {
        if (!confirmModal || !confirmModalMessage || !confirmModalConfirm || !confirmModalCancel) {
          alert(message);
          if (callback && !alertOnly) callback();
          return;
        }
        closeConfirmModal();
        confirmModalMessage.textContent = message;
        currentConfirmCallback = callback;
        if (alertOnly) {
          confirmModalConfirm.textContent = '确定';
          confirmModalCancel.style.display = 'none';
        } else {
          confirmModalConfirm.textContent = '确认';
          confirmModalCancel.style.display = 'inline-block';
        }
        confirmModal.classList.add('show');
      }
      function closeConfirmModal() {
        if (confirmModal) confirmModal.classList.remove('show');
      }
      function handleConfirmModalConfirm() {
        if (currentConfirmCallback) {
          currentConfirmCallback();
        }
        closeConfirmModal();
      }
      function handleWindowClick(event) {
        if (confirmModal && event.target === confirmModal) {
          closeConfirmModal();
        }
        if (qrModal && event.target === qrModal) { 
          closeQrModal();
        }
        if (editSuffixModal && event.target === editSuffixModal) {
          editSuffixModal.classList.remove('show');
        }
      }
      function showEditSuffixModal(url) {
        console.log('显示修改后缀弹窗:', url, '弹窗元素:', !!editSuffixModal);
        if (!editSuffixModal) {
          console.error('修改后缀弹窗元素不存在');
          alert('修改后缀功能不可用');
          return;
        }
        currentEditUrl = url;
        const urlObj = new URL(url);
        const pathParts = urlObj.pathname.split('/');
        const fileName = pathParts[pathParts.length - 1];
        const fileNameParts = fileName.split('.');
        const extension = fileNameParts.pop(); 
        const currentSuffix = fileNameParts.join('.'); 
        const editSuffixInput = document.getElementById('editSuffixInput');
        if (editSuffixInput) {
          editSuffixInput.value = currentSuffix;
          editSuffixModal.classList.add('show');
        } else {
          console.error('找不到编辑后缀输入框');
        }
      }
      async function deleteFile(url, card) {
        try {
          const urlObj = new URL(url);
          const pathParts = urlObj.pathname.split('/');
          const fileName = pathParts[pathParts.length - 1];
          const response = await fetch('/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: url, fileId: fileName }) 
          });
          if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || errorData.message || '删除失败');
          }
          if (card) {
            card.remove();
          } else {
            const card = document.querySelector(\`[data-url="\${url}"]\`);
            if (card) card.remove();
          }
          showConfirmModal('文件删除成功', null, true);
        } catch (error) {
          showConfirmModal('文件删除失败: ' + error.message, null, true);
        }
      }
      async function deleteSelectedFiles() {
        const checkboxes = document.querySelectorAll('.file-checkbox:checked');
        const urls = Array.from(checkboxes).map(cb => cb.value);
        try {
          const response = await fetch('/delete-multiple', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls })
          });
          if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || '批量删除失败');
          }
          checkboxes.forEach(cb => {
            const card = cb.closest('.file-card');
            if (card) card.remove();
          });
          showConfirmModal('批量删除成功', null, true);
        } catch (error) {
          showConfirmModal('批量删除失败: ' + error.message, null, true);
        }
      }
      async function deleteCategory() {
        const select = document.getElementById('categoryDeleteSelect');
        if (!select) return;
        const categoryId = select.value;
        try {
          const response = await fetch('/delete-category', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: categoryId })
          });
          const data = await response.json();
          if (data.status === 1) {
            select.remove(select.selectedIndex);
            showConfirmModal(data.msg, () => {
              window.location.reload();
            }, true);
          } else {
            showConfirmModal(data.msg, null, true);
          }
        } catch (error) {
          showConfirmModal('删除分类失败: ' + error.message, null, true);
        }
      }
      async function updateFileSuffix() {
        const editSuffixInput = document.getElementById('editSuffixInput');
        if (!editSuffixInput) return;
        const newSuffix = editSuffixInput.value;
        try {
          const response = await fetch('/update-suffix', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              url: currentEditUrl,
              suffix: newSuffix
            })
          });
          const data = await response.json();
          if (data.status === 1) {
            if (editSuffixModal) editSuffixModal.classList.remove('show');
            const card = document.querySelector('.file-card[data-url="' + currentEditUrl + '"]');
            if (card) {
              card.setAttribute('data-url', data.newUrl);
              const shareBtn = card.querySelector('.btn-share');
              const deleteBtn = card.querySelector('.btn-delete');
              const editBtn = card.querySelector('.btn-edit');
              if (shareBtn) {
                const fileName = getFileName(data.newUrl);
                shareBtn.setAttribute('onclick', 'shareFile("' + data.newUrl + '", "' + fileName + '")');
              }
              if (deleteBtn) {
                const newOnclick = deleteBtn.getAttribute('onclick').replace(currentEditUrl, data.newUrl);
                deleteBtn.setAttribute('onclick', newOnclick);
              }
              if (editBtn) {
                editBtn.setAttribute('onclick', 'showEditSuffixModal("' + data.newUrl + '")');
              }
              const fileNameElement = card.querySelector('.file-info div:first-child');
              if (fileNameElement) {
                const urlObj = new URL(data.newUrl);
                const fileName = urlObj.pathname.split('/').pop();
                fileNameElement.textContent = fileName;
              }
              const checkbox = card.querySelector('.file-checkbox');
              if (checkbox) {
                checkbox.value = data.newUrl;
              }
            }
            currentEditUrl = data.newUrl;
            showConfirmModal(data.msg, null, true);
          } else {
            showConfirmModal(data.msg || '修改后缀失败', null, true);
          }
        } catch (error) {
          showConfirmModal('修改后缀时出错：' + error.message, null, true);
        }
      }
      function getFileName(url) {
        try {
          const urlObj = new URL(url);
          const pathParts = urlObj.pathname.split('/');
          return pathParts[pathParts.length - 1];
        } catch (e) {
          return url.split('/').pop() || url;
        }
      }
    </script>
  </body>
  </html>`;
}
async function handleUpdateSuffixRequest(request, config) {
  try {
    const { url, suffix } = await request.json();
    if (!url || !suffix) {
      return new Response(JSON.stringify({
        status: 0,
        msg: '文件链接和后缀不能为空'
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    const originalFileName = getFileName(url);
    let fileRecord = await config.database.prepare('SELECT * FROM files WHERE url = ?')
      .bind(url).first();
    if (!fileRecord) {
      fileRecord = await config.database.prepare('SELECT * FROM files WHERE fileId = ?')
        .bind(originalFileName).first();
      if (!fileRecord) {
        return new Response(JSON.stringify({
          status: 0,
          msg: '未找到对应的文件记录'
        }), { headers: { 'Content-Type': 'application/json' } });
      }
    }
    const fileExt = originalFileName.split('.').pop();
    const newFileName = `${suffix}.${fileExt}`;
    let fileUrl = `https://${config.domain}/${newFileName}`;
    const existingFile = await config.database.prepare('SELECT * FROM files WHERE fileId = ? AND id != ?')
      .bind(newFileName, fileRecord.id).first();
    if (existingFile) {
      return new Response(JSON.stringify({
        status: 0,
        msg: '后缀已存在，无法修改'
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    const existingUrl = await config.database.prepare('SELECT * FROM files WHERE url = ? AND id != ?')
      .bind(fileUrl, fileRecord.id).first();
    if (existingUrl) {
      return new Response(JSON.stringify({
        status: 0,
        msg: '该URL已被使用，请尝试其他后缀'
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    console.log('准备更新文件:', {
      记录ID: fileRecord.id,
      原URL: fileRecord.url,
      原fileId: fileRecord.fileId,
      存储类型: fileRecord.storage_type,
      新文件名: newFileName,
      新URL: fileUrl
    });
    if (fileRecord.storage_type === 'telegram') {
      await config.database.prepare('UPDATE files SET url = ? WHERE id = ?')
        .bind(fileUrl, fileRecord.id).run();
      console.log('Telegram文件更新完成:', {
        id: fileRecord.id,
        新URL: fileUrl
      });
    } 
    else if (config.bucket) {
      try {
        const fileId = fileRecord.fileId || originalFileName;
        console.log('尝试从R2获取文件:', fileId);
        const file = await config.bucket.get(fileId);
        if (file) {
          console.log('R2文件存在，正在复制到新名称:', newFileName);
          const fileData = await file.arrayBuffer();
          await storeFile(fileData, newFileName, file.httpMetadata.contentType, config);
          await deleteFile(fileId, config);
          await config.database.prepare('UPDATE files SET fileId = ?, url = ? WHERE id = ?')
            .bind(newFileName, fileUrl, fileRecord.id).run();
          console.log('R2文件更新完成:', {
            id: fileRecord.id,
            新fileId: newFileName,
            新URL: fileUrl
          });
        } else {
          console.log('R2中未找到文件，只更新URL:', fileId);
          await config.database.prepare('UPDATE files SET url = ? WHERE id = ?')
            .bind(fileUrl, fileRecord.id).run();
        }
      } catch (error) {
        console.error('处理R2文件重命名失败:', error);
        await config.database.prepare('UPDATE files SET url = ? WHERE id = ?')
          .bind(fileUrl, fileRecord.id).run();
      }
    } 
    else {
      console.log('未知存储类型，只更新URL');
      await config.database.prepare('UPDATE files SET url = ? WHERE id = ?')
        .bind(fileUrl, fileRecord.id).run();
    }
    return new Response(JSON.stringify({
      status: 1,
      msg: '后缀修改成功',
      newUrl: fileUrl
    }), { headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error('更新后缀失败:', error);
    return new Response(JSON.stringify({
      status: 0,
      msg: '更新后缀失败: ' + error.message
    }), { headers: { 'Content-Type': 'application/json' } });
  }
} 
function generateNewUrl(url, suffix, config) {
  const fileName = getFileName(url);
  const newFileName = suffix + '.' + fileName.split('.').pop();
  return `https://${config.domain}/${newFileName}`;
}
function getFileName(url) {
  const urlObj = new URL(url);
  const pathParts = urlObj.pathname.split('/');
  return pathParts[pathParts.length - 1];
}
function copyToClipboard(text) {
  navigator.clipboard.writeText(text)
    .then(() => {
      showConfirmModal('已复制到剪贴板', null, true);
    })
    .catch(() => {
      showConfirmModal('复制失败，请手动复制', null, true);
    });
}
function getExtensionFromMime(mimeType) {
  if (!mimeType) return 'jpg';
  const mimeMap = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp',
    'image/avif': 'avif',
    'image/tiff': 'tiff',
    'image/x-icon': 'ico',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/ogg': 'ogv',
    'video/x-msvideo': 'avi',
    'video/quicktime': 'mov',
    'video/x-ms-wmv': 'wmv',
    'video/x-flv': 'flv',
    'video/x-matroska': 'mkv',
    'video/x-m4v': 'm4v',
    'video/mp2t': 'ts',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/flac': 'flac',
    'audio/x-ms-wma': 'wma',
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/rtf': 'rtf',
    'application/zip': 'zip',
    'application/x-rar-compressed': 'rar',
    'application/x-7z-compressed': '7z',
    'application/x-tar': 'tar',
    'application/gzip': 'gz',
    'text/plain': 'txt',
    'text/markdown': 'md',
    'text/csv': 'csv',
    'text/html': 'html',
    'text/css': 'css',
    'text/javascript': 'js',
    'application/javascript': 'js',
    'application/json': 'json',
    'application/xml': 'xml',
    'font/ttf': 'ttf',
    'font/otf': 'otf',
    'font/woff': 'woff',
    'font/woff2': 'woff2',
    'application/vnd.ms-fontobject': 'eot',
    'application/octet-stream': 'bin',
    'application/x-shockwave-flash': 'swf'
  };
  return mimeMap[mimeType] || 'bin';
}
async function uploadToR2(arrayBuffer, fileName, mimeType, config) {
  try {
    return await storeFile(arrayBuffer, fileName, mimeType, config);
  } catch (error) {
    console.error('上传到R2失败:', error);
    throw new Error(`上传到存储服务失败: ${error.message}`);
  }
}
async function storeFile(arrayBuffer, fileName, mimeType, config) {
  if (config.bucket) {
    try {
      await config.bucket.put(fileName, arrayBuffer, {
        httpMetadata: { contentType: mimeType || 'application/octet-stream' }
      });
      return `https://${config.domain}/${fileName}`;
    } catch (error) {
      console.error(`R2存储失败: ${error.message}`);
      return await storeFileInTelegram(arrayBuffer, fileName, mimeType, config);
    }
  } else {
    return await storeFileInTelegram(arrayBuffer, fileName, mimeType, config);
  }
}
async function storeFileInTelegram(arrayBuffer, fileName, mimeType, config) {
  if (!config.tgBotToken || !config.tgStorageChatId) {
    throw new Error('未配置Telegram存储参数 (TG_BOT_TOKEN 和 TG_STORAGE_CHAT_ID)');
  }
  const formData = new FormData();
  const blob = new Blob([arrayBuffer], { type: mimeType || 'application/octet-stream' });
  formData.append('document', blob, fileName);
  const response = await fetch(`https://api.telegram.org/bot${config.tgBotToken}/sendDocument?chat_id=${config.tgStorageChatId}`, {
    method: 'POST',
    body: formData
  });
  const result = await response.json();
  if (result.ok) {
    const fileId = result.result.document.file_id;
    const fileUrl = await getTelegramFileUrl(fileId, config.tgBotToken, config);
    return fileUrl;
  } else {
    throw new Error('Telegram存储失败: ' + JSON.stringify(result));
  }
}
async function getFile(fileId, config) {
  if (config.bucket) {
    try {
      return await config.bucket.get(fileId);
    } catch (error) {
      console.error('R2获取文件失败:', error);
      return null;
    }
  }
  return null;
}
async function deleteFile(fileId, config) {
  if (config.bucket) {
    try {
      await config.bucket.delete(fileId);
      return true;
    } catch (error) {
      console.error('R2删除文件失败:', error);
      return false;
    }
  }
  return true; 
}
async function fetchNotification() {
  try {
    const response = await fetch('https://raw.githubusercontent.com/iawooo/cftc/refs/heads/main/cftc/panel.md');
    if (!response.ok) {
      return null;
    }
    return await response.text();
  } catch (error) {
    return null;
  }
}
function copyShareUrl(url, fileName) {
  console.log('复制分享链接:', url);
  try {
    navigator.clipboard.writeText(url)
      .then(() => {
        alert('链接已复制到剪贴板: ' + url);
      })
      .catch((err) => {
        console.error('复制失败:', err);
        prompt('请手动复制以下链接:', url);
      });
  } catch (error) {
    console.error('复制出错:', error);
    prompt('请手动复制以下链接:', url);
  }
}
try {
  document.addEventListener('DOMContentLoaded', function() {
    try {
      console.log('DOM加载完成，初始化页面元素引用');
      window.editSuffixModal = document.getElementById('editSuffixModal');
      if (window.editSuffixModal) {
        console.log('成功获取修改后缀弹窗元素');
      } else {
        console.error('无法获取修改后缀弹窗元素');
      }
      window.currentEditUrl = '';
      window.shareFile = shareFile;
      window.showConfirmModal = showConfirmModal;
      window.showEditSuffixModal = showEditSuffixModal;
      window.deleteFile = deleteFile;
      window.handleConfirmModalConfirm = handleConfirmModalConfirm;
      window.closeConfirmModal = closeConfirmModal;
      window.confirmModal = document.getElementById('confirmModal');
      window.confirmModalMessage = document.getElementById('confirmModalMessage');
      window.confirmModalConfirm = document.getElementById('confirmModalConfirm');
      window.confirmModalCancel = document.getElementById('confirmModalCancel');
    } catch (error) {
      console.error('初始化页面元素引用时出错:', error);
    }
  });
} catch (error) {
  console.error('添加DOMContentLoaded事件监听器失败:', error);
}
  
