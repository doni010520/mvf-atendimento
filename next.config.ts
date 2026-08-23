import type { NextConfig } from "next";

const securityHeaders = [
  // Impede clickjacking — só a própria origem pode colocar em iframe.
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  // Impede sniffing de MIME.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Força HTTPS por 1 ano (incluindo subdomínios).
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  // Não envia Referer para origens externas.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Recursos sensíveis: microfone (gravar áudio) e geolocalização (enviar local)
  // liberados só para a PRÓPRIA origem; câmera e pagamento seguem bloqueados.
  { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=(self), payment=()" },
  // CSP: restringe origens de scripts/estilos/conexões.
  // AJUSTE conforme adicionar CDNs/fontes externas.
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // Scripts: self + inline (Next.js usa inline) + eval apenas em dev
      "script-src 'self' 'unsafe-inline'" + (process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""),
      // Estilos: self + inline (Tailwind/styled-components)
      "style-src 'self' 'unsafe-inline'",
      // Imagens: self + data URIs + uploads do Supabase
      `img-src 'self' data: blob: ${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}`,
      // Fontes: self
      "font-src 'self'",
      // Conexões: self + Supabase (API + Realtime)
      `connect-src 'self' ${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""} wss://*.supabase.co`,
      // Mídia (áudio/vídeo): self + blob (preview) + Supabase (áudios/vídeos re-hospedados)
      `media-src 'self' data: blob: ${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}`,
      // Service worker (PWA): sem worker-src explícito ele herda script-src, que
      // já libera 'self' — declarado aqui para não quebrar se script-src mudar.
      "worker-src 'self'",
      // Manifest do PWA.
      "manifest-src 'self'",
      // Frames: só a própria origem
      "frame-ancestors 'self'",
      "object-src 'none'",
      "base-uri 'self'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  // Saída standalone: imagem Docker pequena e self-contained (server.js).
  output: "standalone",

  experimental: {
    serverActions: {
      // Padrão do Next é 1MB — bloqueava QUALQUER vídeo (e fotos grandes) no
      // envio de mídia do atendimento, silenciosamente. 64mb cobre vídeos de
      // celular; o teto real de vídeo da Meta (16MB) é avisado no composer.
      bodySizeLimit: "64mb",
    },
  },

  async headers() {
    return [
      {
        // Aplica em todas as rotas.
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
