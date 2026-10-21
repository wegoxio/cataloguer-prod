import type { Metadata } from 'next';
import { LegalPage, H2 } from '../../components/legal/legal-page';

export const metadata: Metadata = {
  title: 'Términos de Servicio — Catalog',
  robots: { index: true },
};

export default function TerminosPage() {
  return (
    <LegalPage title="Términos de Servicio" updated="14 de julio de 2026">
      <p>
        Estos Términos de Servicio (los «Términos») regulan el uso de <strong>Catalog</strong>, el
        servicio de gestión de catálogos operado por <strong>Wegox LLC</strong>, una sociedad de
        responsabilidad limitada constituida en el Estado de Delaware, Estados Unidos («Wegox», «nosotros»).
        Al crear una cuenta, aceptar una invitación o utilizar el servicio, aceptas estos Términos en nombre
        propio y, si corresponde, en nombre de la empresa que representas (el «Cliente»).
      </p>

      <H2>1. El servicio</H2>
      <p>
        Catalog es un panel de administración que permite al Cliente gestionar su catálogo de
        artículos, precios, inventario, pedidos, proveedores y equipos, y publicar ese catálogo en uno o más
        sitios web conectados mediante nuestra API. El alcance concreto (número de sitios web y usuarios)
        depende del plan contratado, descrito en la página de Facturación y en nuestra propuesta comercial.
      </p>

      <H2>2. Cuentas y seguridad</H2>
      <p>
        Las cuentas se crean por invitación. El Cliente es responsable de mantener la confidencialidad de
        sus credenciales, de la actividad realizada desde sus cuentas y de retirar el acceso de las personas
        que dejen de formar parte de su equipo. Ofrecemos herramientas de seguridad — verificación en dos
        pasos, gestión de sesiones activas y registro de actividad — y recomendamos activarlas. Debes
        notificarnos de inmediato a{' '}
        <a href="mailto:support@wegox.io" className="text-primary hover:underline">
          support@wegox.io
        </a>{' '}
        cualquier uso no autorizado.
      </p>

      <H2>3. Planes, pagos y renovación</H2>
      <p>
        El servicio se factura por suscripción mensual, por adelantado, en dólares estadounidenses (USD),
        según el plan contratado. Los pagos con tarjeta se procesan a través de Stripe; también aceptamos
        métodos de pago acordados directamente (por ejemplo, transferencia). La suscripción se renueva
        automáticamente cada mes hasta su cancelación. Los precios vigentes se muestran siempre antes de
        pagar. Podemos modificar los precios notificándolo con al menos 30 días de antelación; el cambio
        aplica a partir del siguiente período de facturación.
      </p>
      <p>
        <strong>Impago:</strong> si un pago falla o la suscripción vence, el panel de administración pasa a
        modo de solo lectura hasta regularizar el pago. El sitio web público del Cliente y su catálogo
        publicado <strong>no se desconectan</strong> por impago durante un período razonable; nos reservamos
        el derecho de suspender el servicio por completo tras 60 días de mora.
      </p>

      <H2>4. Cancelación y reembolsos</H2>
      <p>
        El Cliente puede cancelar en cualquier momento, sin permanencia mínima, desde el portal de pagos o
        escribiéndonos. La cancelación surte efecto al final del período mensual ya pagado: el servicio
        sigue disponible hasta esa fecha. <strong>No se emiten reembolsos por períodos iniciados</strong>,
        salvo error de cobro imputable a nosotros. Tras la cancelación, los datos del Cliente se conservan
        durante 60 días por si desea reactivar; después pueden eliminarse de forma permanente.
      </p>

      <H2>5. Contenido y propiedad</H2>
      <p>
        Todo el contenido que el Cliente carga — artículos, precios, fotos, datos de pedidos, información de
        proveedores — es y sigue siendo <strong>propiedad del Cliente</strong>. Wegox no adquiere ningún
        derecho sobre él, salvo la licencia limitada necesaria para operar el servicio (almacenarlo,
        mostrarlo en sus sitios web conectados, respaldarlo). El software, el diseño y la marca de Wegox
        Catalog son propiedad de Wegox LLC. El Cliente puede exportar sus datos en cualquier momento con las
        herramientas de exportación del panel.
      </p>

      <H2>6. Uso aceptable</H2>
      <p>
        El Cliente se compromete a no usar el servicio para actividades ilícitas, para vender productos cuya
        comercialización esté prohibida en su jurisdicción, para infringir derechos de terceros (incluidas
        fotos o marcas ajenas sin autorización), ni para intentar vulnerar la seguridad de la plataforma.
        Podemos suspender cuentas que incumplan esta cláusula, notificando la causa.
      </p>

      <H2>7. Disponibilidad y soporte</H2>
      <p>
        Operamos el servicio con proveedores de infraestructura líderes y monitoreo continuo, y trabajamos
        para mantener la máxima disponibilidad, pero el servicio se presta «tal cual» y no garantizamos
        disponibilidad ininterrumpida. Realizamos copias de seguridad diarias de los datos. El soporte se
        presta en español por correo electrónico en horario comercial de Venezuela.
      </p>

      <H2>8. Limitación de responsabilidad</H2>
      <p>
        En la máxima medida permitida por la ley, la responsabilidad total de Wegox frente al Cliente por
        cualquier reclamación derivada del servicio se limita al importe pagado por el Cliente en los tres
        (3) meses anteriores al hecho que la origine. Wegox no responde por daños indirectos, lucro cesante
        o pérdida de negocio, ni por fallos atribuibles a los sitios web del Cliente, su conectividad o
        servicios de terceros fuera de nuestro control.
      </p>

      <H2>9. Protección de datos</H2>
      <p>
        El tratamiento de datos personales se rige por nuestra{' '}
        <a href="/privacidad" className="text-primary hover:underline">
          Política de Privacidad
        </a>{' '}
        y, respecto de los datos de los clientes finales del Cliente, por el Anexo de Encargo de Tratamiento
        (DPA) incluido al final de estos Términos.
      </p>

      <H2>10. Modificaciones</H2>
      <p>
        Podemos actualizar estos Términos. Los cambios sustanciales se notificarán por correo o mediante un
        aviso en el panel con al menos 15 días de antelación. El uso continuado del servicio tras la fecha
        de efecto constituye aceptación de los nuevos Términos.
      </p>

      <H2>11. Ley aplicable</H2>
      <p>
        Estos Términos se rigen por las leyes del Estado de Delaware, Estados Unidos, sin perjuicio de las
        normas imperativas de protección al consumidor que resulten aplicables en la jurisdicción del
        Cliente. Antes de acudir a los tribunales, las partes intentarán resolver cualquier controversia de
        buena fe mediante negociación directa.
      </p>

      <H2>12. Contacto</H2>
      <p>
        Wegox LLC ·{' '}
        <a href="mailto:support@wegox.io" className="text-primary hover:underline">
          support@wegox.io
        </a>
      </p>

      <H2>Anexo — Encargo de tratamiento de datos (DPA)</H2>
      <p>
        Este anexo aplica cuando el Cliente almacena en Catalog datos personales de sus propios
        clientes finales (por ejemplo, nombre y teléfono en los pedidos). Respecto de esos datos, el Cliente
        actúa como <strong>responsable del tratamiento</strong> y Wegox como{' '}
        <strong>encargado del tratamiento</strong>.
      </p>
      <p>Wegox, como encargado, se compromete a:</p>
      <ul className="list-disc space-y-1 pl-6">
        <li>Tratar los datos únicamente para prestar el servicio y siguiendo instrucciones del Cliente.</li>
        <li>
          Aplicar medidas de seguridad apropiadas: cifrado en tránsito, aislamiento por empresa,
          autenticación reforzada, registro de actividad y copias de seguridad diarias.
        </li>
        <li>
          Emplear únicamente los subencargados listados en la{' '}
          <a href="/privacidad" className="text-primary hover:underline">
            Política de Privacidad
          </a>{' '}
          (infraestructura de nube, pagos y correo transaccional), informando de cambios relevantes.
        </li>
        <li>Notificar al Cliente sin dilación indebida cualquier violación de seguridad que afecte a sus datos.</li>
        <li>
          Suprimir o devolver los datos al terminar la relación, conforme al plazo de conservación descrito
          en la cláusula 4.
        </li>
        <li>Asistir razonablemente al Cliente en la atención de solicitudes de derechos de sus clientes finales.</li>
      </ul>
    </LegalPage>
  );
}
