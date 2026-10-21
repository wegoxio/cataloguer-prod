import type { Metadata } from 'next';
import { LegalPage, H2 } from '../../components/legal/legal-page';

export const metadata: Metadata = {
  title: 'Política de Privacidad — Catalog',
  robots: { index: true },
};

const SUBPROCESSORS: [string, string, string][] = [
  ['Amazon Web Services (Lightsail y S3)', 'UE/EE. UU. según región elegida', 'Alojamiento y almacenamiento de la aplicación'],
  ['Supabase (PostgreSQL)', 'EE. UU.', 'Base de datos'],
  ['Vercel', 'EE. UU.', 'Alojamiento de la interfaz web'],
  ['Cloudflare (R2/CDN)', 'Global', 'Almacenamiento y entrega de imágenes y archivos'],
  ['Stripe', 'EE. UU.', 'Procesamiento de pagos con tarjeta'],
  ['Resend', 'EE. UU.', 'Envío de correos transaccionales'],
  ['Sentry', 'UE (Alemania)', 'Monitoreo de errores técnicos'],
];

export default function PrivacidadPage() {
  return (
    <LegalPage title="Política de Privacidad" updated="14 de julio de 2026">
      <p>
        Esta política explica qué datos personales trata <strong>Wegox LLC</strong> (Delaware, EE. UU.) al
        operar Catalog, con qué finalidad y qué derechos tienes. Aplica al panel de administración, a
        la página wegoxcatalog.com y a las comunicaciones asociadas al servicio.
      </p>

      <H2>1. Qué datos tratamos</H2>
      <ul className="list-disc space-y-1 pl-6">
        <li>
          <strong>Datos de cuenta:</strong> correo electrónico, nombre (opcional), empresa, rol, contraseña
          (almacenada solo como hash criptográfico — nunca en texto claro), configuración de verificación en
          dos pasos.
        </li>
        <li>
          <strong>Datos de uso y seguridad:</strong> registro de actividad del panel (quién hizo qué y
          cuándo), sesiones activas con dirección IP y navegador, y errores técnicos.
        </li>
        <li>
          <strong>Datos de facturación:</strong> historial de pagos y estado de la suscripción. Los datos de
          tarjeta los recibe y custodia exclusivamente Stripe; nunca pasan por nuestros servidores.
        </li>
        <li>
          <strong>Datos de clientes finales (como encargado):</strong> si tu empresa recibe pedidos por su
          sitio web, almacenamos el nombre y teléfono que sus compradores indiquen. Estos datos pertenecen a
          la empresa cliente; los tratamos solo por su cuenta (ver el DPA en los{' '}
          <a href="/terminos" className="text-primary hover:underline">
            Términos
          </a>
          ).
        </li>
      </ul>

      <H2>2. Para qué los usamos</H2>
      <p>
        Exclusivamente para prestar y asegurar el servicio: autenticar usuarios, operar el catálogo y los
        pedidos, procesar pagos, enviar correos transaccionales (invitaciones, restablecimiento de
        contraseña, avisos de seguridad), prevenir abusos y diagnosticar errores. <strong>No vendemos datos
        ni los usamos para publicidad.</strong> No enviamos correos de marketing.
      </p>

      <H2>3. Cookies</H2>
      <p>
        Usamos únicamente cookies estrictamente necesarias: una cookie de sesión segura (httpOnly) para
        mantener el inicio de sesión. No usamos cookies de análisis, publicidad ni seguimiento, por lo que
        no mostramos banner de cookies. Las preferencias de idioma se guardan localmente en tu navegador.
      </p>

      <H2>4. Con quién compartimos datos (subencargados)</H2>
      <p>Nos apoyamos en proveedores de infraestructura que tratan datos por nuestra cuenta:</p>
      <div className="overflow-x-auto">
        <table className="min-w-full text-xs">
          <thead>
            <tr className="border-b border-slate-200 text-left text-slate-500">
              <th className="py-2 pr-4">Proveedor</th>
              <th className="py-2 pr-4">Ubicación</th>
              <th className="py-2">Función</th>
            </tr>
          </thead>
          <tbody>
            {SUBPROCESSORS.map(([name, where, what]) => (
              <tr key={name} className="border-b border-slate-100">
                <td className="py-2 pr-4 font-medium text-slate-700">{name}</td>
                <td className="py-2 pr-4">{where}</td>
                <td className="py-2">{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        Algunos proveedores están fuera de tu país; en esos casos los datos se transfieren bajo las
        salvaguardas contractuales estándar de cada proveedor. Fuera de esta lista, solo revelaríamos datos
        si una autoridad competente lo exige legalmente.
      </p>

      <H2>5. Cuánto tiempo los conservamos</H2>
      <p>
        Mientras la cuenta de la empresa esté activa y hasta 60 días después de su cancelación (para
        permitir reactivarla). Las copias de seguridad se conservan 30 días. El registro de actividad se
        conserva mientras exista la cuenta, como medida de seguridad y trazabilidad.
      </p>

      <H2>6. Seguridad</H2>
      <p>
        Cifrado en tránsito (HTTPS) en todas las comunicaciones, contraseñas con hash Argon2, verificación
        en dos pasos disponible, secretos cifrados en reposo, aislamiento de datos por empresa, bloqueo por
        intentos fallidos, registro de actividad y copias de seguridad diarias.
      </p>

      <H2>7. Tus derechos</H2>
      <p>
        Puedes acceder, corregir o eliminar tus datos, y solicitar una copia exportable, escribiendo a{' '}
        <a href="mailto:support@wegox.io" className="text-primary hover:underline">
          support@wegox.io
        </a>
        . Si eres cliente final de una empresa que usa Catalog (por ejemplo, hiciste un pedido en su
        sitio web), dirígete primero a esa empresa, que es la responsable de tus datos; también puedes
        escribirnos y te asistiremos.
      </p>

      <H2>8. Cambios</H2>
      <p>
        Publicaremos aquí cualquier cambio de esta política y, si es sustancial, lo avisaremos por correo o
        en el panel con antelación razonable.
      </p>
    </LegalPage>
  );
}
