# eazydata

一个面向 [magpie](https://usemagpie.ai) 的 **eazydata**
(<https://eazydata.org>) 供应商插件 —— 它是一个 OpenAI 兼容中转站，用一个
base URL、一个 API Key，把许多模型家族聚在身后。

相比手写一条 `providers.json` 记录，插件额外提供：

- **真实读取模型列表。** eazydata 并不对外公布固定的模型清单，所以插件为已登录
  的账号实时读取 `GET /v1/models`，只提供这把 Key 真正能调用的模型。上游新加的
  模型无需新版插件即可使用；插件不认识的模型会得到一份宽松的通用描述（文/图输入、
  支持工具调用、128K 上下文），而不是被丢弃。
- **能读到就用上的额度。** 中转站用 `x-quota-*` 响应头报告用量。`usage` 读取一次
  响应，把它变成 magpie 展示与路由用的窗口。绝不编造数字：没有这些响应头时，窗口
  只给一行说明、不给百分比，而不是写成 0%。
- **可用的重置时间。** 当额度用完、中转站返回 429 却没带 `Retry-After` 时，插件会
  依据重置时刻补一个，让这把 Key 休息到额度恢复；而普通的并发 429 仍保留中转站自己
  的短 `Retry-After`。

## 安装

```sh
magpie plugin add ./eazydata
# 或发布后：magpie plugin add eazydata
magpie plugin login eazydata
```

然后把某个 Agent 的模型选成 `eazydata/<模型>`。

### 供应商 id

插件登录的供应商 id 是 **`eazydata`**。如果 `providers.json` 里已有一条手写的
`eazydata` 记录，请先改名，或者两个都加上后用 `magpie plugin use` 选一个 ——
同一个 id 声明两次时，一次只服务其中一个（选中的那个，否则后加的）。

## 登录

在 <https://eazydata.org> 申请一把 API Key。保存前会用 `GET /v1/models` 校验：

- 被中转站拒绝 → 登录失败，并显示中转站自己的错误信息；
- 中转站不可达 → 仍然保留这把 Key，一次网络抖动不会把你锁在门外。

Key 由 magpie 存在 `plugin-auth.json` 的 `eazydata` 名下，一把 Key 就是一个账号：
再用第二把 Key 登录会存成 `eazydata#xxxxxx`，各自有独立的额度与并发。
`magpie plugin logout eazydata` 可忘掉它。

## 线路

eazydata 提供四条 OpenAI 兼容的 base URL：

| 线路 | Base URL | 说明 |
| --- | --- | --- |
| 主站 | `https://eazydata.org/v1` | 默认。优化加速线路，国内访问。 |
| 备用 | `https://zzz.kkpliu.top/v1` | 备用线路。 |
| 备用（大陆） | `https://cn.eazydata.org/v1` | 推荐给中国大陆用户。 |
| 带文件 / 超时 | `https://upload.eazydata.org/v1` | 499/524 等状态码超时使用。 |

插件默认走 **主站**。要换线路，实例化时传 `baseURL` 选项，例如
`EazyDataPlugin(input, { baseURL: "https://cn.eazydata.org/v1" })`，或在
`providers.json` 里覆盖该供应商的 `api`。四条线路也从包里以 `LINES` 导出。

## 模型

没有内置清单。`config` 只发布一个占位条目（`eazydata-default`），让 magpie 在登录
前也有供应商可展示；一旦账号登录，`provider.models` 就用账号真实的 `GET
/v1/models` 结果替换它。Token 按套餐额度计费而非金额，所以每个模型都把金额成本设为 0。

## 不做的事

没有每日签到（中转站没有领取接口），也没有需要刷新的登录态 —— 401 表示 Key 被吊销，
插件会报告为 `signIn: "expired"`。

## 目录

```
index.mjs          magpie 加载的入口
opencode.mjs       OpenCode 1.x 门面
opencode2.mjs      OpenCode 2.x 门面（与社区副本逐字节一致）
src/index.mjs      插件本体：config、auth、provider.models
src/models.mjs     通用模型形态 + 账号实时模型列表
src/quota.mjs      x-quota-* 响应头 → 用量窗口
test/              测试，`npm test` 运行
```

## 开发

```sh
npm test          # 全部测试，不联网
npm run check     # 语法检查 + 测试
```

测试使用 `fetch` 替身，不会真正连到中转站。

## 许可

MIT。
