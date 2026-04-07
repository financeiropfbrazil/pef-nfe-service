/**
 * pef-nfe-service
 * 
 * Microsserviço para consulta de NFS-e via SEFAZ Nacional (Padrão Nacional NFSe v1.0)
 * Usa certificado digital A1 (.pfx) enviado em base64 a cada requisição.
 * 
 * Endpoints:
 *   GET  /                              - Health check
 *   POST /api/nfse-consulta-dfe-decoded - Consulta DPS por NSU e retorna XMLs decodificados
 */

const express = require('express');
const cors = require('cors');
const https = require('https');
const axios = require('axios');
const forge = require('node-forge');
const zlib = require('zlib');
const { XMLParser } = require('fast-xml-parser');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS - permite o Financial Hub
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://finance-pf.lovable.app,http://localhost:5173,http://localhost:8080').split(',');
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      return callback(null, true);
    }
    callback(new Error('CORS bloqueado'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-secret'],
}));

app.use(express.json({ limit: '50mb' }));

// API Secret opcional
const API_SECRET = process.env.API_SECRET || '';
function checkApiSecret(req, res, next) {
  if (!API_SECRET) return next();
  const provided = req.headers['x-api-secret'];
  if (provided !== API_SECRET) {
    return res.status(401).json({ success: false, message: 'API secret inválido' });
  }
  next();
}

// SEFAZ Nacional NFSe URLs
const SEFAZ_URLS = {
  '1': 'https://sefin.nfse.gov.br', // Produção
  '2': 'https://hom.nfse.fazenda.gov.br', // Homologação
};

// ============================================
// HEALTH CHECK
// ============================================
app.get('/', (req, res) => {
  res.json({
    service: 'pef-nfe-service',
    version: '1.0.0',
    status: 'online',
    endpoints: [
      'POST /api/nfse-consulta-dfe-decoded',
    ],
  });
});

// ============================================
// CONSULTA NFS-e DPS
// ============================================
app.post('/api/nfse-consulta-dfe-decoded', checkApiSecret, async (req, res) => {
  try {
    const { pfxBase64, passphrase, tpAmb, NSU, maxDocs } = req.body;

    if (!pfxBase64 || !passphrase) {
      return res.status(400).json({
        success: false,
        message: 'pfxBase64 e passphrase são obrigatórios',
      });
    }

    const ambiente = String(tpAmb || '1');
    const baseUrl = SEFAZ_URLS[ambiente] || SEFAZ_URLS['1'];
    const nsuInicial = String(NSU || '0');
    const limite = Math.min(Number(maxDocs) || 50, 100);

    console.log(`[NFS-e] Consulta - Ambiente: ${ambiente}, NSU: ${nsuInicial}, MaxDocs: ${limite}`);

    // Extrair CNPJ e PEM do certificado
    const certInfo = extractCertInfo(pfxBase64, passphrase);
    if (!certInfo) {
      return res.status(400).json({
        success: false,
        message: 'Falha ao processar certificado digital. Verifique o arquivo e a senha.',
      });
    }

    const { cnpj, pemCert, pemKey } = certInfo;
    console.log(`[NFS-e] CNPJ extraído do certificado: ${cnpj}`);

    // Criar httpsAgent com mTLS
    const httpsAgent = new https.Agent({
      cert: pemCert,
      key: pemKey,
      rejectUnauthorized: false,
      keepAlive: true,
    });

    // Endpoint REST da SEFAZ Nacional NFSe
    // GET /sefinNacional/nfse?NSU={nsu}
    const url = `${baseUrl}/SefinNacional/nfse?NSU=${nsuInicial}`;

    let response;
    try {
      response = await axios.get(url, {
        httpsAgent,
        timeout: 60000,
        validateStatus: () => true,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'pef-nfe-service/1.0',
        },
      });
    } catch (axiosErr) {
      console.error('[NFS-e] Erro Axios:', axiosErr.message);
      return res.status(502).json({
        success: false,
        message: `Erro de conexão com SEFAZ: ${axiosErr.message}`,
      });
    }

    console.log(`[NFS-e] SEFAZ respondeu com status ${response.status}`);

    // 404 = nenhum documento
    if (response.status === 404) {
      return res.status(404).json({
        success: true,
        decoded: [],
        data: {
          StatusProcessamento: 'NENHUM_DOCUMENTO_LOCALIZADO',
          NSU: nsuInicial,
        },
      });
    }

    // Outros erros
    if (response.status >= 400) {
      return res.status(response.status).json({
        success: false,
        message: `SEFAZ retornou HTTP ${response.status}`,
        data: response.data,
      });
    }

    // Parse da resposta
    const data = response.data;
    const decoded = await parseNfseDistribuicaoResponse(data, limite);

    console.log(`[NFS-e] ${decoded.length} documentos decodificados`);

    return res.json({
      success: true,
      decoded,
      data: {
        StatusProcessamento: decoded.length > 0 ? 'OK' : 'NENHUM_DOCUMENTO_LOCALIZADO',
        NSU: nsuInicial,
        TotalDocumentos: decoded.length,
      },
    });

  } catch (err) {
    console.error('[NFS-e] Erro inesperado:', err);
    return res.status(500).json({
      success: false,
      message: err.message || 'Erro interno',
    });
  }
});

// ============================================
// HELPER: Extrair CNPJ e PEM do certificado
// ============================================
function extractCertInfo(pfxBase64, passphrase) {
  try {
    const pfxDer = Buffer.from(pfxBase64, 'base64');
    const pfxAsn1 = forge.asn1.fromDer(pfxDer.toString('binary'));
    const p12 = forge.pkcs12.pkcs12FromAsn1(pfxAsn1, passphrase);

    let cert = null;
    let privateKey = null;

    // Encontrar certificado e chave privada
    for (const safeContents of p12.safeContents) {
      for (const safeBag of safeContents.safeBags) {
        if (safeBag.type === forge.pki.oids.certBag && safeBag.cert) {
          if (!cert) cert = safeBag.cert;
        }
        if (safeBag.type === forge.pki.oids.pkcs8ShroudedKeyBag && safeBag.key) {
          privateKey = safeBag.key;
        }
        if (safeBag.type === forge.pki.oids.keyBag && safeBag.key) {
          privateKey = safeBag.key;
        }
      }
    }

    if (!cert || !privateKey) {
      console.error('[Cert] Não foi possível extrair cert ou key do PFX');
      return null;
    }

    // Extrair CNPJ do Subject Alternative Name ou Subject
    let cnpj = null;
    const subjectFields = cert.subject.attributes;
    for (const attr of subjectFields) {
      if (attr.value && /\d{14}/.test(attr.value)) {
        const match = attr.value.match(/\d{14}/);
        if (match) cnpj = match[0];
      }
    }

    // Tentar extensions (SAN tem o CNPJ no padrão ICP-Brasil)
    if (!cnpj) {
      const sanExtension = cert.getExtension('subjectAltName');
      if (sanExtension && sanExtension.altNames) {
        for (const alt of sanExtension.altNames) {
          if (alt.value && /\d{14}/.test(alt.value)) {
            const match = alt.value.match(/\d{14}/);
            if (match) cnpj = match[0];
          }
        }
      }
    }

    const pemCert = forge.pki.certificateToPem(cert);
    const pemKey = forge.pki.privateKeyToPem(privateKey);

    return { cnpj, pemCert, pemKey };
  } catch (err) {
    console.error('[Cert] Erro ao processar certificado:', err.message);
    return null;
  }
}

// ============================================
// HELPER: Parse da resposta de distribuição NFS-e
// ============================================
async function parseNfseDistribuicaoResponse(data, limite) {
  const decoded = [];

  // A resposta pode vir em vários formatos. Vamos tentar os principais.
  // Formato 1: { LoteDFe: [{ NSU, ArquivoXML, ... }] }
  // Formato 2: { lotedfe: [...] }
  // Formato 3: array direto

  let lote = null;
  if (Array.isArray(data)) {
    lote = data;
  } else if (data?.LoteDFe) {
    lote = Array.isArray(data.LoteDFe) ? data.LoteDFe : [data.LoteDFe];
  } else if (data?.lotedfe) {
    lote = Array.isArray(data.lotedfe) ? data.lotedfe : [data.lotedfe];
  } else if (data?.loteDFe) {
    lote = Array.isArray(data.loteDFe) ? data.loteDFe : [data.loteDFe];
  } else if (data?.documentos) {
    lote = data.documentos;
  }

  if (!lote || lote.length === 0) {
    console.warn('[NFS-e] Resposta sem documentos. Estrutura recebida:', JSON.stringify(data).substring(0, 500));
    return decoded;
  }

  const xmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
  });

  for (const item of lote.slice(0, limite)) {
    try {
      // Campo do XML pode ter nomes variados
      const xmlField = item.ArquivoXML || item.arquivoXML || item.arquivoXml || item.xml || item.XML;
      const nsu = item.NSU || item.nsu || item.NSUId || 0;
      const tipoDoc = item.TipoDocumento || item.tipoDocumento || 'NFSE';
      const tipoEvento = item.TipoEvento || item.tipoEvento || null;
      const dataGeracao = item.DataHoraGeracao || item.dataHoraGeracao || new Date().toISOString();

      if (!xmlField) {
        console.warn(`[NFS-e] Documento NSU ${nsu} sem campo XML`);
        continue;
      }

      // O XML vem em base64 + gzip (padrão SEFAZ Nacional)
      let xmlString;
      try {
        const gzipped = Buffer.from(xmlField, 'base64');
        xmlString = zlib.gunzipSync(gzipped).toString('utf-8');
      } catch (gzipErr) {
        // Se não for gzip, tentar como base64 puro
        try {
          xmlString = Buffer.from(xmlField, 'base64').toString('utf-8');
        } catch {
          // Se não for base64, usar como string direta
          xmlString = xmlField;
        }
      }

      // Extrair chave de acesso do XML
      let chaveAcesso = '';
      try {
        const parsed = xmlParser.parse(xmlString);
        chaveAcesso = extractChaveAcesso(parsed);
      } catch (parseErr) {
        console.warn(`[NFS-e] Falha ao parsear XML do NSU ${nsu}:`, parseErr.message);
      }

      decoded.push({
        NSU: Number(nsu),
        ChaveAcesso: chaveAcesso || `SEM_CHAVE_${nsu}`,
        TipoDocumento: tipoDoc.toUpperCase().includes('EVENTO') ? 'EVENTO' : 'NFSE',
        TipoEvento: tipoEvento,
        DataHoraGeracao: dataGeracao,
        xml: xmlString,
      });
    } catch (itemErr) {
      console.error('[NFS-e] Erro processando item do lote:', itemErr.message);
    }
  }

  return decoded;
}

// ============================================
// HELPER: Extrair chave de acesso do XML parseado
// ============================================
function extractChaveAcesso(parsed) {
  // Recursivamente procurar por campos que possam conter a chave (44+ dígitos)
  const search = (obj) => {
    if (!obj || typeof obj !== 'object') return null;
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        // Chave NFS-e Nacional tem 50 caracteres
        if (/^\d{44,50}$/.test(value.replace(/\s/g, ''))) {
          return value.replace(/\s/g, '');
        }
        // Atributo Id geralmente tem prefixo "NFSe" + chave
        if (key === '@_Id' && /\d{44,50}/.test(value)) {
          const match = value.match(/\d{44,50}/);
          if (match) return match[0];
        }
      } else if (typeof value === 'object') {
        const found = search(value);
        if (found) return found;
      }
    }
    return null;
  };
  return search(parsed) || '';
}

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
  console.log(`🚀 pef-nfe-service rodando na porta ${PORT}`);
  console.log(`   Allowed origins: ${allowedOrigins.join(', ')}`);
  console.log(`   API Secret: ${API_SECRET ? 'configurado' : 'não configurado (aberto)'}`);
});
