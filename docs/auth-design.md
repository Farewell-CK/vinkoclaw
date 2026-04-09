# 用户登录模块设计方案

## 1. API 设计

### 1.1 认证端点

| 方法 | 路径 | 描述 | 认证要求 |
|------|------|------|----------|
| POST | `/api/auth/login` | 用户登录 | 无 |
| POST | `/api/auth/logout` | 用户登出 | Bearer Token |
| GET | `/api/auth/validate` | 验证会话有效性 | Bearer Token |
| GET | `/api/auth/me` | 获取当前用户信息 | Bearer Token |
| POST | `/api/auth/refresh` | 刷新访问令牌 | Bearer Token |

### 1.2 请求/响应结构

#### POST /api/auth/login

**请求体:**
```typescript
interface LoginRequest {
  username: string;    // 用户名，必填，1-64字符
  password: string;    // 密码，必填，8-128字符
  remember?: boolean;  // 记住登录，延长会话有效期
}
```

**成功响应 (200):**
```typescript
interface LoginSuccessResponse {
  ok: true;
  user: {
    id: string;
    username: string;
    role: "owner" | "operator" | "viewer";
    displayName: string;
  };
  token: string;      // 访问令牌
  expiresAt: string;  // ISO 8601 时间戳
}
```

**失败响应:**
```typescript
interface LoginErrorResponse {
  ok: false;
  error: AuthErrorCode;
  message: string;
  retryAfter?: number;  // 账户锁定时返回，秒
}
```

#### POST /api/auth/logout

**成功响应 (200):**
```typescript
interface LogoutResponse {
  ok: true;
}
```

#### GET /api/auth/validate

**成功响应 (200):**
```typescript
interface ValidateResponse {
  ok: true;
  user: {
    id: string;
    username: string;
    role: string;
    displayName: string;
  };
}
```

**失败响应 (401):**
```typescript
interface ValidateErrorResponse {
  ok: false;
  error: "missing_token" | "invalid_token" | "token_expired";
}
```

## 2. 数据结构设计

### 2.1 用户记录 (UserRecord)

```typescript
interface UserRecord {
  id: string;                    // UUID v4
  username: string;              // 唯一用户名
  email?: string;                // 可选邮箱
  passwordHash: string;          // bcrypt 哈希，cost=12
  role: UserRole;                // owner | operator | viewer
  displayName: string;           // 显示名称
  isActive: boolean;             // 账户是否激活
  failedLoginAttempts: number;   // 连续登录失败次数
  lockedUntil?: string;          // 账户锁定截止时间
  lastLoginAt?: string;          // 最后登录时间
  loginCount: number;            // 总登录次数
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
```

### 2.2 会话记录 (AuthSessionRecord)

```typescript
interface AuthSessionRecord {
  id: string;                    // 会话ID
  userId: string;                // 关联用户ID
  token: string;                 // 访问令牌 (SHA-256 hash 存储)
  userAgent?: string;            // 客户端 User-Agent
  ipAddress?: string;            // 客户端 IP 地址
  expiresAt: string;             // 过期时间
  createdAt: string;             // 创建时间
  lastAccessedAt: string;        // 最后访问时间
}
```

### 2.3 认证审计事件 (AuthAuditEvent)

```typescript
interface AuthAuditEvent {
  id: string;
  category: "auth";
  eventType: "login_success" | "login_failed" | "logout" | "token_refresh" | "account_locked";
  userId?: string;
  username?: string;
  ipAddress: string;
  userAgent?: string;
  message: string;
  metadata: {
    reason?: string;
    attemptCount?: number;
  };
  createdAt: string;
}
```

## 3. 错误处理设计

### 3.1 错误码定义

```typescript
type AuthErrorCode =
  | "username_and_password_required"  // 缺少用户名或密码
  | "invalid_credentials"             // 用户名或密码错误
  | "account_locked"                  // 账户已锁定
  | "account_inactive"                // 账户已停用
  | "missing_token"                   // 缺少认证令牌
  | "invalid_token"                   // 无效的认证令牌
  | "token_expired"                   // 令牌已过期
  | "rate_limited"                    // 请求频率超限
  | "internal_error";                 // 内部错误
```

### 3.2 HTTP 状态码映射

| 错误码 | HTTP 状态码 | 说明 |
|--------|-------------|------|
| username_and_password_required | 400 | 请求参数错误 |
| invalid_credentials | 401 | 认证失败 |
| account_locked | 423 | 账户被锁定 |
| account_inactive | 403 | 账户已停用 |
| missing_token | 401 | 未提供认证信息 |
| invalid_token | 401 | 认证信息无效 |
| token_expired | 401 | 会话已过期 |
| rate_limited | 429 | 请求过于频繁 |
| internal_error | 500 | 服务器内部错误 |

### 3.3 错误响应示例

```json
{
  "ok": false,
  "error": "account_locked",
  "message": "账户已被临时锁定，请 5 分钟后重试",
  "retryAfter": 300
}
```

## 4. 安全策略设计

### 4.1 密码策略

- **最小长度**: 8 字符
- **最大长度**: 128 字符
- **哈希算法**: bcrypt, cost factor = 12
- **禁止明文存储**: 所有密码必须哈希后存储

### 4.2 登录失败限制

```typescript
interface LoginRateLimit {
  maxAttempts: 5;           // 最大失败次数
  lockoutDurationMs: 300000; // 锁定时长 (5分钟)
  resetWindowMs: 900000;    // 计数重置窗口 (15分钟)
}
```

### 4.3 会话策略

```typescript
interface SessionPolicy {
  defaultExpiryMs: 86400000;   // 默认有效期 (24小时)
  extendedExpiryMs: 604800000; // 延长有效期 (7天)
  maxSessionsPerUser: 5;       // 每用户最大会话数
  tokenLength: 32;             // 令牌长度 (字节)
}
```

### 4.4 令牌安全

- 使用 `crypto.getRandomValues()` 生成安全随机令牌
- 令牌以 SHA-256 哈希形式存储
- 登出时立即失效令牌
- 支持主动使所有会话失效

## 5. 观测点设计

### 5.1 日志点

| 事件 | 日志级别 | 字段 |
|------|----------|------|
| 登录成功 | INFO | userId, username, ip, userAgent |
| 登录失败 | WARN | username, ip, reason, attemptCount |
| 账户锁定 | WARN | userId, username, ip, lockedUntil |
| 会话验证 | DEBUG | tokenId, userId, ip |
| 登出 | INFO | userId, tokenId |

### 5.2 指标 (Prometheus)

```
# 登录尝试计数
vinkoclaw_auth_login_attempts_total{status="success|failed"} counter

# 活跃会话数
vinkoclaw_auth_active_sessions gauge

# 登录延迟
vinkoclaw_auth_login_duration_seconds histogram

# 账户锁定计数
vinkoclaw_auth_account_lockouts_total counter
```

### 5.3 审计事件

所有认证相关操作记录到 `audit_events` 表:

```typescript
store.appendAuditEvent({
  category: "auth",
  entityType: "user",
  entityId: userId,
  message: "User logged in successfully",
  payload: {
    eventType: "login_success",
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"]
  }
});
```

## 6. 实现计划

### Phase 1: 核心功能 (已完成基础版)
- [x] 基础登录/登出 API
- [x] Token 生成与验证
- [x] 环境变量配置用户

### Phase 2: 安全增强
- [ ] 密码哈希 (bcrypt)
- [ ] 登录失败限制
- [ ] 账户锁定机制
- [ ] IP 限流

### Phase 3: 持久化
- [ ] 用户数据持久化
- [ ] 会话持久化
- [ ] 审计日志持久化

### Phase 4: 观测性
- [ ] 结构化日志
- [ ] Prometheus 指标
- [ ] 审计事件追踪

### Phase 5: 测试
- [ ] 单元测试
- [ ] 集成测试
- [ ] 安全测试

## 7. 配置项

```typescript
interface AuthConfig {
  // 用户凭据配置 (开发环境)
  credentials: Array<{ username: string; password: string }>;
  
  // 安全策略
  security: {
    bcryptCost: number;           // bcrypt cost factor
    maxLoginAttempts: number;     // 最大登录失败次数
    lockoutDurationMs: number;    // 锁定时长
    tokenExpiryMs: number;        // 令牌有效期
    extendedTokenExpiryMs: number; // 延长有效期
  };
  
  // 限流配置
  rateLimit: {
    windowMs: number;             // 时间窗口
    maxRequests: number;          // 最大请求数
  };
}
```
