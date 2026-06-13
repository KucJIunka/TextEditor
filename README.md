# Text Adapter Extension

Chrome / Firefox (Manifest V3) — адаптация сложности текста на веб-страницах через AI.

## Соответствие требованиям проекта

| Требование | Реализация |
|------------|------------|
| Chrome / Firefox | `manifest.json` + `browser_specific_settings.gecko` |
| Выделение или вся страница | Popup → **Выделение** / **Вся страница** |
| ≥ 3 уровня адаптации | **Light**, **Medium**, **Max** |
| Результат на странице | Блок на странице с адаптированным текстом |
| Возврат к оригиналу | Кнопки **Оригинал** / **Вернуть как было** |
| Не менять страницу навсегда | Оригинал в DOM сохраняется, скрывается временно |
| Сравнение оригинал / адапт | Кнопка **Сравнение** на странице + боковая панель |
| Бесплатные / локальные AI | Ollama, LM Studio, **Groq** (free tier) |
| Клиентская архитектура | Service worker + content script, без своего сервера |
| Настройки | Options: провайдер, модель, ключ, fast mode |
| Git | Репозиторий с исходниками в `extension/` |

## Сценарий для защиты

1. Установить расширение → `chrome://extensions/` → Load unpacked → `extension/`
2. Options → **Groq** или **Ollama** → Save → Test connection
3. Открыть страницу (Wikipedia, документация, статья)
4. Выделить текст → **Адаптировать**
5. На странице: **Адаптировано** → **Сравнение** → **Оригинал** → **Вернуть как было**
6. Повторить с уровнями Light / Medium / Max
7. Показать **Вся страница** на другом типе контента

### Рекомендуемые страницы для демо (3+ типа)

- **Научная / энциклопедия:** ru.wikipedia.org
- **Документация:** developer.mozilla.org
- **Юридический / нормативный:** consultant.ru или zakon.ru

## Быстрый старт без Ollama (Groq)

1. Ключ: [console.groq.com](https://console.groq.com)
2. Options → **Быстрая настройка → Groq**
3. Вставить API key → Save → Test connection
4. Адаптировать текст на странице

## Быстрый старт с Ollama (локально)

```bash
ollama pull llama3.2:3b
OLLAMA_ORIGINS="chrome-extension://*" ollama serve
```

Options → **Ollama** → Test connection.

## Структура

```
extension/
  manifest.json       — Chrome + Firefox MV3
  content_script.js   — извлечение текста, UI на странице
  content_script.css  — стили блока адаптации
  service_worker.js   — запросы к AI
  popup.html/js       — управление
  sidepanel.html/js   — доп. панель сравнения (Chrome)
  options.html/js     — настройки и пресеты
```

## Firefox

1. `about:debugging` → This Firefox → Load Temporary Add-on
2. Выбрать `extension/manifest.json`
3. Боковая панель Chrome недоступна — используйте UI **на странице**

## Устранение неполадок

- **403 от Ollama:** `OLLAMA_ORIGINS="chrome-extension://*" ollama serve`
- **sidePanel.open gesture:** панель открывается при клике; основной UI — на странице
- **Пропущены абзацы:** обновите расширение (v0.2.0+), выделяйте от начала первого до конца последнего абзаца
