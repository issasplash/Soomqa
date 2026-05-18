# Soomqa

Personal crypto yield monitor — single-page web app that compares CEX funding rates with DeFi APYs in one view, plus a Telegram alert bot that pings you when a yield crosses a threshold. Open in any browser. No terminal, no install, no API keys.

## Live URL

```
https://issasplash.github.io/Soomqa/
```

Откроется на телефоне или ноутбуке. Авто-обновление каждые 60 секунд.

### Установить как приложение на iPhone

1. Открой URL в Safari
2. Нажми кнопку **Share** (квадрат со стрелкой вверх)
3. Прокрути и выбери **Add to Home Screen** / «На экран Домой»
4. Дай имя «Soomqa» (или оставь предложенное)

После этого Soomqa появится на главном экране как обычное приложение, открывается без браузерной строки. То же самое работает на Android через Chrome (меню → «Установить приложение»).

## Что показывает

- **Все perp-рынки** на Binance, Bybit и Hyperliquid (~1700 символов) с funding rates пересчитанными в APR
- **DeFi доходности** с Aave, Morpho, Spark, Sky, Pendle, Ethena, EigenLayer, Ether.fi, Renzo, Kelp, Puffer — через DefiLlama
- **Умное определение ликвидности**: каждая строка помечена `liquid: true/false` на основе реальных сигналов — 24h volume, open interest, basis (perp vs spot), `apyBase` vs `apyReward`, флаг `outlier` от DefiLlama
- **Equity perps** (SNDK/CRCL/QQQ/GOOGL и пр.) автоматически детектируются через `underlyingType` в Binance exchangeInfo и не попадают в "лучший в целом"
- **Поиск, фильтры по категории, мин/макс APR, чекбокс "только ликвидные"** — фильтры сохраняются в localStorage

Все данные read-only публичные. Без аккаунтов, без кошелька, без API-ключей.

## Telegram-алерты

GitHub Actions опрашивает источники каждые 5 минут и шлёт сообщения в Telegram при появлении интересных сигналов:

| Тип сигнала | Порог | Дедупликация |
|---|---|---|
| Funding-спайк | APR ≥ 50% на ликвидном рынке | 4 часа |
| Фикс. доходность | Pendle PT APR ≥ 15% | 12 часов |
| Лендинг стейблов | Aave/Morpho/Spark APR ≥ 8% | 12 часов |
| Δ-нейтрал | Ethena APR ≥ 15% | 6 часов |

Дополнительно — **ежедневный обзор** в 11:00 МСК с топ-5 yields по каждой категории.

## Портфельный сканер (опционально)

Раз в 30 минут можно получать в Telegram сводку **по всем твоим открытым позициям** на Binance, Bybit и Hyperliquid — балансы, открытые сделки, нереализованный PnL.

### Безопасность

- API ключи лежат **только в GitHub Actions Secrets** (encrypted at rest)
- Никогда не попадают в браузер, в localStorage, в логи
- Используются **read-only** ключи — без права торговать или выводить средства
- Hyperliquid использует **публичный адрес** — никаких ключей вообще не требуется

### Создание read-only ключей

Поддерживаются: **Bybit, OKX, BingX, MEXC, Gate.io, HTX, Binance, Hyperliquid**.
Настраивай только те где торгуешь — остальные пропускаются автоматически.

> **Для пользователей в России / CIS:** Binance официально недоступен. Все остальные биржи из списка работают без VPN.

Общий принцип для всех CEX:
- Создаёшь **API key** с правами **только на чтение** (Read-Only / View)
- Никаких Trade, Withdrawal, Transfer permissions
- IP whitelist можно оставить пустым (read-only ключ безопасен)

| Биржа | Где создать ключ | Какие permissions | Особенности |
|---|---|---|---|
| **Bybit** | Profile → API → Create New Key (System-generated, Read-Only) | Contract → Position; Wallet → Account Transfer (Read) | — |
| **OKX** | Profile → API → Create V5 API key | только **Read** | + **passphrase** (придумываешь сам при создании) |
| **BingX** | Settings → API Management → Create API | только **Read** | — |
| **MEXC** | Profile → API Management → Create | только **Read Info / View** | Futures (Contract) keys; spot не покрывается |
| **Gate.io** | Settings → API Keys → Create API Key | Futures: только **Read Only** | — |
| **HTX** | Profile → API Management → Create | Read-only | Linear USDT-M Cross Margin |
| **Binance** | Profile → API Management → Create | Enable Reading + Enable Futures (без Trading/Withdraw) | Недоступен в РФ |
| **Hyperliquid** | — | — | Достаточно публичного адреса 0x... |

### Подключение в GitHub Secrets

**Settings → Secrets and variables → Actions** → New repository secret. Добавь только то, чем пользуешься:

| Биржа | Secrets |
|---|---|
| Bybit | `BYBIT_API_KEY`, `BYBIT_API_SECRET` |
| OKX | `OKX_API_KEY`, `OKX_API_SECRET`, `OKX_PASSPHRASE` |
| BingX | `BINGX_API_KEY`, `BINGX_API_SECRET` |
| MEXC | `MEXC_API_KEY`, `MEXC_API_SECRET` |
| Gate.io | `GATE_API_KEY`, `GATE_API_SECRET` |
| HTX | `HTX_API_KEY`, `HTX_API_SECRET` |
| Binance | `BINANCE_API_KEY`, `BINANCE_API_SECRET` |
| Hyperliquid | `HYPERLIQUID_ADDRESS` (публичный 0x…) |

Уже добавлены: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (от alerts).

После добавления — **Actions → Portfolio scan → Run workflow** для проверки. В Telegram должна прийти сводка со всеми твоими позициями.

### Настройка Telegram-бота (один раз)

1. **Создать бота:**
   - Открыть [@BotFather](https://t.me/BotFather) в Telegram
   - `/newbot` → задать имя и username
   - BotFather пришлёт **token** вида `123456:ABC-DEF...`

2. **Узнать свой chat_id:**
   - Открыть [@userinfobot](https://t.me/userinfobot) в Telegram
   - Бот ответит твоим ID — это **chat_id** (число)
   - Прежде чем бот сможет тебе писать, **отправь /start своему боту** один раз

3. **Положить секреты в GitHub:**
   - В репозитории: **Settings → Secrets and variables → Actions → New repository secret**
   - Добавить `TELEGRAM_BOT_TOKEN` (token из шага 1)
   - Добавить `TELEGRAM_CHAT_ID` (число из шага 2)

4. **Готово.** Workflow запустится автоматически по расписанию. Можно сразу проверить вручную: **Actions → Yield alerts → Run workflow**.

Если секреты не настроены — workflow всё равно будет крутиться (не упадёт), просто ничего не отправит и залогирует "TELEGRAM_BOT_TOKEN not set — skipping".

## Запуск локально (опционально)

```bash
git clone https://github.com/issasplash/soomqa.git
cd soomqa
# Open index.html in any browser — that's it.
```

Никаких зависимостей не надо ставить. Чтобы запустить alert-скрипт локально:

```bash
TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node scripts/check-yields.mjs
```

(Node 20+ — нужен встроенный `fetch`.)

## Архитектура

```
index.html               markup, Tailwind CDN, semantic table
style.css                dark theme, APR colour scale, badges
app.js                   browser fetchers + state + render
scripts/
  check-yields.mjs       same fetchers + alert rules + Telegram sender
.github/workflows/
  deploy.yml             GitHub Pages deploy on push to main
  alerts.yml             5-min cron, runs check-yields.mjs
```

Vanilla JS, без сборки, без фреймворков, без backend.

## Источники данных

| Источник | Endpoint | Что покрывает |
|---|---|---|
| Binance | `fapi.binance.com/fapi/v1/{premiumIndex,ticker/24hr,exchangeInfo}` | Все USDT/USDC perp funding rates + volume + контракт-метаданные |
| Bybit | `api.bybit.com/v5/market/tickers?category=linear` | Все linear perp funding rates + turnover + OI |
| Hyperliquid | `api.hyperliquid.xyz/info` (POST) | Все HL perp funding rates + дневной объём + OI + oraclePx |
| DefiLlama | `yields.llama.fi/pools` | Aave, Morpho, Pendle, Ethena, restaking LRTs, и т.д. |

Все endpoints публичные и CORS-friendly. Если один источник падает — остальные рендерятся, ошибка показывается баннером.

## Roadmap

- ✅ **Phase 1** — Read-only live comparison across CEX funding + DeFi yields
- ✅ **Phase 2** — Telegram-алерты на спайки funding / новые DeFi-возможности
- **Phase 3** — Position tracker: вписываешь свои депозиты, видишь realised vs theoretical yield, drift alerts
- **Phase 4** — Pendle Boros fetcher (fixed funding rate lock-in)
- **Phase 5** — Paper trading simulator: бот "пробует" сделки, не трогая реальные деньги, ты видишь как бы он торговал
- **Phase 6** — Live execution (только после Phase 5 покажет стабильную прибыль, и капитал вырастет до $3K+)
