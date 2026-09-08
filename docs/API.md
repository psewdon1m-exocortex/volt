# Volt API v1

Операторские endpoints используют HttpOnly `volt_session` cookie и same-origin
mutation policy. Machine endpoint принимает только общий Bearer token Kernel.
Все ответы API отправляются с `Cache-Control: no-store`.

## Operator

| Method | Path | Назначение |
| --- | --- | --- |
| `POST` | `/api/v1/session` | Unlock по `{ "access_key": "…" }` |
| `DELETE` | `/api/v1/session` | Lock |
| `GET/POST` | `/api/v1/entries` | Список masked entries / создание |
| `PUT/DELETE` | `/api/v1/entries/:id` | Новая ревизия / soft delete |
| `POST` | `/api/v1/entries/:id/fields/:field/reveal` | Явное раскрытие |
| `GET` | `/api/v1/entries/:id/revisions` | Метаданные истории |
| `POST` | `/api/v1/entries/:id/revisions/:revision/restore` | Restore как новая ревизия |
| `POST` | `/api/v1/generate` | CSPRNG generators |
| `GET` | `/api/v1/audit` | Redacted audit |
| `GET` | `/api/v1/vault-file` | Согласованный переносимый `personal.volt` snapshot |
| `GET` | `/api/v1/vault-file/info` | Версия формата, vault ID и параметры KDF без секретов |
| `GET` | `/api/v1/backup` | Свежий ZIP |
| `POST` | `/api/v1/backup/inspect` | Проверка ZIP без мутации |
| `POST` | `/api/v1/backup/restore` | Подтверждённый replace restore |

## Machine resolve

```http
POST /api/v1/internal/kernel/resolve
Authorization: Bearer <VOLT_KERNEL_TOKEN>
Content-Type: application/json

{"references":["volt://<entry-id>/<field-id>"]}
```

```json
{
  "schema": "volt.resolve.v1",
  "resolution_revision": "sha256-base64url",
  "values": {
    "volt://<entry-id>/<field-id>": {
      "value": "resolved for Kernel",
      "revision": 3,
      "visibility": "plain"
    }
  }
}
```

Batch ограничен 20 уникальными ссылками и использует all-or-nothing resolution.
Volt не ведёт principals или grants: этот endpoint доступен только Kernel.
`resolution_revision` зависит от ссылок и номеров ревизий, но не от значений.
`visibility` имеет значение `plain` или `secret` и позволяет Kernel сохранить
корректную метку в ответе, не меняя общий путь разрешения.
