# config.json 格式规范

模板目录下每个 config.json 描述了该模板的可配置参数接口，支持静态值和动态生成两种来源。

## 目录结构

```
templates/
├── config.schema.json           # 协议 config.json 的 JSON Schema
├── overall-config.schema.json   # 总体模板 config.json 的 JSON Schema
├── protocols/
│   ├── config.schema.json       # (可选) 同根目录
│   ├── vless-reality-vision/
│   │   ├── config.json
│   │   ├── server.json
│   │   └── client.json
│   └── hysteria2/
│       ├── config.json
│       ├── server.json
│       └── client.json
├── server/
│   └── default/
│       ├── config.json
│       └── template.json
├── client/
│   └── default/
│       ├── config.json
│       └── template.json
└── docker/
    └── default/
        ├── config.json
        └── template.json
```

## 协议 config.json（Protocol）

```jsonc
{
  "$schema": "../config.schema.json",  // IDE 自动补全（可选）
  "name": "VLESS Reality Vision",      // 协议显示名（必填）
  "version": "1.0.0",                  // 版本号（必填，semver）
  "description": "...",                // 描述（可选）
  "params": [                          // 参数定义数组（必填）
    {
      "name": "port",                  // 参数名（必填，字母/数字/下划线）
      "type": "number",                // 参数类型（必填：string|number|boolean|select）
      "required": true,                // 是否必填（可选，默认 false）
      "default": 443,                  // 默认值（可选，与 generator 互斥）
      "generator": "random_port",      // 生成器（可选，与 default 互斥）
      "description": "...",            // 描述（可选）
      "placeholder": "输入端口号",      // 占位符（可选）
      "enum": ["a", "b"]              // 枚举值（可选，type=select 时使用）
    }
  ]
}
```

### 约束规则

1. **`default` 与 `generator` 互斥**：一个参数不能同时设置二者
2. **值来源缺失**：如果既没有 `default` 也没有 `generator`，则该参数必须标记为 `required: true`（否则用户将无法确定该参数的值）
3. **`name` 命名**：仅允许 `[a-zA-Z_][a-zA-Z0-9_]*`，与模板中 `{{ params.xxx }}` 对应
4. **`type` 枚举**：仅支持 `string` / `number` / `boolean` / `select`
5. **`select` 时 `enum` 必填**：`type: "select"` 必须提供 `enum` 数组列举可选值

## 总体模板 config.json（Overall）

```jsonc
{
  "$schema": "../../overall-config.schema.json",  // IDE 自动补全（可选）
  "name": "Default Server",         // 模板显示名（可选，默认取文件夹名）
  "version": "1.0.0",              // 版本号（可选，默认 "1.0.0"）
  "description": "...",            // 描述（可选）
  "params": []                     // 参数定义（必填，规则同 Protocol 的 params）
}
```

总体模板的 `params` 与协议 `params` 使用相同的 `ParamDef` 格式，约束规则完全一致。

## 校验机制

### 1. 构建时：JSON Schema（IDE 级）

- `config.schema.json` 和 `overall-config.schema.json` 提供 JSON Schema 校验
- VS Code 等编辑器加载后提供字段提示、枚举自动补全、类型检查
- 每个 config.json 通过 `$schema` 字段引用对应 JSON Schema

### 2. 运行时：Zod（seed 时）

- `ProtocolConfigFileSchema` / `OverallConfigFileSchema` 在 `types.ts` 中定义
- Admin seed 路由调用 `validateProtocolConfig()` / `validateOverallConfig()` 校验每个 config.json
- 校验失败返回 400，附带具体错误路径与原因

## 自定义 Generator（fn: 内联）

除了内置生成器，可通过 `fn:` 前缀在 config.json 中内联任意 JS 函数：

```json
{
  "name": "shortId",
  "generator": "fn: return crypto.randomUUID().slice(0, 8);"
}
```

- 函数体用 `new Function()` 编译，每次生成参数时调用一次
- 可访问 Workers 运行时全局 API（`crypto`、`Math`、`Date`、`String` 等）
- 适用于内置生成器无法满足的场景，无需额外文件

### 校验规则矩阵

| 条件 | default | generator | required | 结果 |
|------|---------|-----------|----------|------|
| 有 default | ✅ 设置 | ❌ 无 | — | 使用 default 值 |
| 有 generator | ❌ 无 | ✅ 设置 | — | 调用生成器产生值 |
| 两者都无 | ❌ 无 | ❌ 无 | ✅ true | 用户必须提供值 |
| default + generator | ❌ 互斥 | ❌ 互斥 | — | 校验报错 |
| 两者都无 + required false | ❌ 无 | ❌ 无 | ❌ false | 校验报错 |

## 参数解析流程（运行时）

`resolveAndValidate(defs, userParams)`:

```
用户提供了值？
  ├─ 是 → 类型转换 → enum 校验 → 使用用户值
  └─ 否 → def.default 有意义？
           ├─ 是 → 使用 default
           └─ 否 → def.generator 存在？
                    ├─ 是 → 调用生成器
                    └─ 否 → def.required？
                             ├─ 是 → 报错：缺少必填参数
                             └─ 否 → 跳过（不加入 resolved 结果）
```

## 内置生成器

| 名称 | 格式 | 说明 |
|------|------|------|
| uuid | `uuid` | 生成 UUID v4 |
| hex:N | `hex:8` | 生成 N 字节的十六进制字符串 |
| x25519_keypair | `x25519_keypair` | 生成 X25519 密钥对（JSON `{public,private}` 对象） |
| random_port | `random_port` | 生成随机端口号（1024-65535） |
| random_port_high | `random_port_high:30000` | 生成随机高位端口号（默认 30000-65535，参数指定下界） |
| now_iso | `now_iso` | 当前时间的 ISO 8601 字符串 |
