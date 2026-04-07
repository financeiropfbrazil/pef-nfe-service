# pef-nfe-service

Microsserviço Node.js para consulta de NFS-e via SEFAZ Nacional (Padrão Nacional NFSe v1.0). Usa certificado digital A1 (.pfx) enviado em base64 a cada requisição.

## Endpoints

### `GET /`
Health check.

### `POST /api/nfse-consulta-dfe-decoded`
Consulta DPS por NSU e retorna XMLs decodificados.

**Headers:**
- `Content-Type: application/json`
- `x-api-secret: <secret>` (opcional, se `API_SECRET` estiver configurado)

**Body:**
```json
{
  "pfxBase64": "MIIH...",
  "passphrase": "senha-do-cert",
  "tpAmb": "1",
  "NSU": "572",
  "maxDocs": 50
}
```

**Response (sucesso):**
```json
{
  "success": true,
  "decoded": [
    {
      "NSU": 573,
      "ChaveAcesso": "...",
      "TipoDocumento": "NFSE",
      "TipoEvento": null,
      "DataHoraGeracao": "2026-04-07T10:00:00",
      "xml": "<NFSe>...</NFSe>"
    }
  ],
  "data": {
    "StatusProcessamento": "OK",
    "NSU": "572",
    "TotalDocumentos": 1
  }
}
```

**Response (sem novos):**
```json
{
  "success": true,
  "decoded": [],
  "data": {
    "StatusProcessamento": "NENHUM_DOCUMENTO_LOCALIZADO",
    "NSU": "572"
  }
}
```

## Variáveis de Ambiente

| Variável | Obrigatória | Default | Descrição |
|---|---|---|---|
| `PORT` | Não | 3000 | Porta do servidor |
| `ALLOWED_ORIGINS` | Não | `https://finance-pf.lovable.app,...` | Origens permitidas (CORS), separadas por vírgula |
| `API_SECRET` | Não | (vazio) | Se definido, exige header `x-api-secret` |

## Deploy no Render

### 1. Criar repositório no GitHub

```bash
cd pef-nfe-service
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/financeiropfbrazil/pef-nfe-service.git
git push -u origin main
```

### 2. Criar Web Service no Render

1. Acesse https://dashboard.render.com
2. Clique em **New +** → **Web Service**
3. Conecte ao GitHub e selecione o repo `pef-nfe-service`
4. Configure:
   - **Name:** `pef-nfe-service` (ou outro nome — vai gerar URL `https://NOME.onrender.com`)
   - **Region:** `Oregon (US West)`
   - **Branch:** `main`
   - **Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** `Free`

### 3. Configurar variáveis de ambiente

Em **Environment** adicione:

- `ALLOWED_ORIGINS` = `https://finance-pf.lovable.app`
- `API_SECRET` = `<gere-um-secret-forte>` (opcional, se quiser proteger)

Não precisa adicionar `PORT` (o Render injeta automaticamente).

### 4. Deploy

Clique em **Create Web Service**. O Render vai instalar dependências e iniciar o servidor. Em ~2 minutos a URL estará disponível.

### 5. Testar

```bash
curl https://pef-nfe-service.onrender.com/
```

Deve retornar:
```json
{
  "service": "pef-nfe-service",
  "version": "1.0.0",
  "status": "online",
  ...
}
```

### 6. Configurar no Financial Hub

No Financial Hub, em **Compras > Certificado Digital**, atualizar:
- **URL do Serviço:** `https://pef-nfe-service.onrender.com` (a URL gerada pelo Render)
- **API Secret:** o mesmo secret configurado na etapa 3 (se aplicável)

## Limitações

- **Plano Free do Render:** o serviço dorme após 15 minutos sem requisições. A primeira requisição após dormir pode levar ~30-60s para responder.
- **Timeout SEFAZ:** consultas com muitos documentos podem demorar; o timeout é de 60s.
- **Cooldown SEFAZ:** a SEFAZ Nacional tem rate limit. Não consultar com frequência menor que 1 hora.

## Desenvolvimento Local

```bash
npm install
npm start
```

O servidor sobe em `http://localhost:3000`.
