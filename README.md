# Оболочка ТГ

Проект разделён на frontend и backend:

- `index.html`, `styles.css`, `config.js`, `app.js` — интерфейс GitHub Pages.
- `server.js` — backend Telegram-бота: команда `/start`, проверка подписи Telegram Mini App и отправка файлов с кодом в личный чат пользователя с ботом.

## Как работает отправка кода

Нажатие на карточку кода в оболочке отправляет сам файл в чат Telegram-бота. Код не добавляется в поле ввода ИИ и не отправляется модели повторно. Стрелка справа в карточке по-прежнему копирует/скачивает содержимое локально.

Backend проверяет `Telegram.WebApp.initData` криптографической подписью с использованием токена бота. Токен хранится только в переменных окружения backend-сервиса и никогда не помещается во frontend.

## Фото в запросах к ИИ

Интерфейс принимает PNG, JPG/JPEG, WebP и GIF. Можно прикрепить до 5 файлов; размер одного изображения — до 700 КБ, общий размер вложений в одном сообщении — до 1,2 МБ. Изображения передаются модели как `image_url` в массиве `content` запроса Chat Completions; текст сообщения ставится перед изображениями.

Для OpenRouter оболочка проверяет каталог `GET /models?input_modalities=image`. Если выбранная модель не поддерживает изображения, только запросы с фото автоматически отправляются через бесплатный роутер `openrouter/free`, который подбирает бесплатную модель с поддержкой изображений. Выбранная в чате модель при этом не меняется. В ответе отображается уведомление о переключении.

Для других OpenAI-совместимых API нужно вручную выбрать модель, у которой входные модальности включают `image`. Если сервер сообщает, что модель не поддерживает изображения, оболочка показывает отдельную подсказку.

## Мультиагентная разработка и JavaScript-песочница

В настройках есть раскрывающийся раздел «Разработка и песочница».

- Мультиагентный режим включается отдельно и применяется к запросам, распознанным как задачи с кодом. Вспомогательные агенты анализируют задачу по разным ролям; основная модель получает их отчёты и формирует итоговый ответ.
- Можно выбрать от 1 до 20 ИИ в команде, включая основную модель. Остальные N−1 агентов получают отдельные специализированные роли. Запросы выполняются группами максимум по четыре, чтобы не отправлять все вызовы одновременно.
- Модели для агентов берутся из сохранённого списка моделей и используют текущий адрес API и ключ. Если в списке одна модель, она используется в нескольких ролях. Несколько провайдеров с разными адресами API пока не поддерживаются.
- Агентам отправляется текст задачи, недавний текстовый контекст и текстовые вложения. Изображения остаются в контексте основной модели.
- Включение JavaScript-песочницы и её интернет-доступа настраивается раздельно.
- Сетевой режим песочницы разрешает только HTTPS через `fetch`, публичные доменные имена и ответы с поддержкой CORS. Cookies, локальные адреса/IP, `XMLHttpRequest`, `WebSocket` и `EventSource` блокируются; лимит — 10 запросов и 2 МБ ответа за запуск. Тайм-аут настраивается в том же раскрывающемся разделе от 1 до 3600 секунд; значение по умолчанию — 60 секунд.
- Прямой браузерный `fetch` не обходит CORS. Для API без CORS потребуется отдельный контролируемый backend-шлюз. Для production-среды с недоверенным кодом такой шлюз должен дополнительно проверять DNS/IP после каждого перенаправления и ограничивать доступ на серверном уровне.

Каждый вспомогательный агент делает отдельный API-запрос и может расходовать токены. Отчёты агентов являются рекомендациями, а не доказательством корректности; автоматический запуск тестов и совместное редактирование файлов между агентами относятся к следующим этапам архитектуры.

## Публикация frontend

GitHub Pages продолжает публиковать сайт из ветки `main`, папка `/(root)`.

После каждого коммита Pages автоматически обновит файлы сайта.

## Развёртывание backend на Render

1. Создайте новый Blueprint в Render и выберите этот GitHub-репозиторий. В корне уже лежит `render.yaml`.
2. Во время создания сервиса задайте `BOT_TOKEN` значением токена, полученного у @BotFather. **Не добавляйте токен в GitHub, config.js или сообщения.**
3. `WEB_APP_URL` и `ALLOWED_ORIGINS` уже описаны в Blueprint. Backend сам создаёт случайный hex-секрет для webhook при запуске и регистрирует его в Telegram.
4. После публикации скопируйте публичный адрес backend-сервиса, например `https://имя-сервиса.onrender.com`.
5. Откройте `config.js` и укажите этот адрес в `apiBaseUrl`, без завершающего слэша:
   ```js
   window.APP_CONFIG = Object.freeze({
     apiBaseUrl: "https://имя-сервиса.onrender.com"
   });
   ```
6. Сохраните и отправьте `config.js` в GitHub. Дождитесь обновления GitHub Pages.
7. Откройте чат с ботом и отправьте `/start`. Backend автоматически установит webhook и бот ответит сообщением о разработке с кнопкой открытия мини-приложения.

Если у сервиса Render меняется публичный адрес, обновите `apiBaseUrl` в `config.js`.

## Лимиты

Для файлов исходного кода в репозитории нет искусственного лимита в 1 МБ. По правилам GitHub:

- GitHub рекомендует держать отдельные Git-объекты примерно до 1 MiB; после 50 MiB Git показывает предупреждение.
- Обычный Git блокирует отдельные файлы больше 100 MiB. Для больших бинарных файлов существует Git LFS, но Git LFS не публикуется через GitHub Pages.
- GitHub Contents API имеет отдельное ограничение возможностей для файлов больше 1 MiB; при работе с такими файлами нужны raw/Git Data операции.

Для отправки сгенерированного файла в чат Telegram используется Bot API `sendDocument`: актуальный лимит Telegram — **50 МБ на документ**. Это ограничение Telegram, а не ограничение GitHub или оболочки.

Отдельно: прикрепление локальных файлов *в запрос к ИИ* в текущей версии всё ещё имеет свои небольшие лимиты и хранится вместе с историей чатов в браузере. Это не ограничивает размер исходников в GitHub или отправляемых ИИ файлов, но такую подсистему хранения нужно отдельно перевести на IndexedDB, прежде чем безопасно повышать её лимиты.

У модели и API-провайдера также есть собственные ограничения на длину контекста и ответа. Они не ограничивают размер репозитория в GitHub.


## Безопасность

- API-ключ провайдера хранится только в памяти текущей вкладки. Он не попадает в localStorage, IndexedDB и резервные копии. После перезагрузки или смены адреса API ключ нужно вставить заново.
- Telegram initData проверяется на backend по HMAC-SHA256; подпись старше одного часа отклоняется.
- Backend ограничивает частоту отправки и размер запросов, а также использует тайм-ауты и защитные HTTP-заголовки.
- JavaScript-песочница работает в отдельном sandboxed iframe без allow-same-origin. Сетевой режим включается отдельно; он ограничен HTTPS, CORS, количеством запросов и размером ответа, но не является серверным DNS/IP-фильтром.

Подробности, ограничения и рекомендации по настройке GitHub/Render см. в [SECURITY.md](./SECURITY.md) и [отчёте обновления](./docs/SECURITY-UPDATE-2026-11-19.md). Перед публикацией запускайте npm test.


## Telegram AI chat (feature branch)

The Telegram chat backend uses PostgreSQL for durable user settings and conversation history.

Required Render environment variables for this feature:
- `DATABASE_URL`: connection string for a persistent PostgreSQL database.
- `DATA_ENCRYPTION_KEY`: exactly 64 hexadecimal characters (32 random bytes), used for AES-256-GCM encryption of provider API keys at rest. Generate with `openssl rand -hex 32`.
- Existing `BOT_TOKEN`, `WEB_APP_URL`, `ALLOWED_ORIGINS` remain required as applicable.

The Mini App stores the active provider key in that browser's `localStorage` for convenience and syncs it to the backend using verified Telegram Mini App initData. The backend stores only an encrypted copy. A different API URL clears the locally saved key. This increases convenience but means browser scripts/extensions with access to the page may be able to read the key; protect the account and avoid untrusted browser extensions.

Telegram commands implemented in this branch:
- `/chat` and `/new`: create a conversation.
- `/stop`: stop the active conversation while retaining its transcript.
- `/model_info`: list saved model IDs and the active model.
- `/model <provider/model>` or `/model-<provider/model>`: select and save a model ID.

The active conversation is marked sleeping after 60 seconds without a new message; its transcript remains in PostgreSQL. Render's own free-service sleep behavior remains separate and is controlled by Render (typically 15 minutes without inbound traffic).

This branch does not yet include GitHub OAuth/repository permissions or GitHub-backed code analysis. Those require a GitHub OAuth App (client ID/secret and callback URL) or GitHub App credentials, plus a separate permission and repository-selection flow. Do not paste GitHub credentials into chat or commit them to the repository.
