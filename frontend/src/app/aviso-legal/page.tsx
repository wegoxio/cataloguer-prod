import type { Metadata } from 'next';
import { LegalPage, H2 } from '../../components/legal/legal-page';

export const metadata: Metadata = {
  title: 'Aviso Legal — Catalog',
  robots: { index: true },
};

export default function AvisoLegalPage() {
  return (
    <LegalPage title="Aviso Legal" updated="14 de julio de 2026">
      <H2>Titular del sitio y del servicio</H2>
      <p>
        Catalog y el sitio wegoxcatalog.com son operados por <strong>Wegox LLC</strong>, sociedad de
        responsabilidad limitada constituida conforme a las leyes del Estado de Delaware, Estados Unidos de
        América.
      </p>
      <p>
        Contacto:{' '}
        <a href="mailto:support@wegox.io" className="text-primary hover:underline">
          support@wegox.io
        </a>
      </p>

      <H2>Propiedad intelectual</H2>
      <p>
        El software, el diseño, los textos y la marca «Catalog» son propiedad de Wegox LLC. El
        contenido cargado por cada empresa cliente (artículos, fotos, precios) es propiedad de esa empresa.
        No está permitida la reproducción del sitio o del servicio sin autorización.
      </p>

      <H2>Responsabilidad sobre sitios conectados</H2>
      <p>
        Los sitios web de las empresas clientes que consumen el catálogo mediante nuestra API son operados
        por dichas empresas, que responden de su contenido, sus precios y sus ofertas frente a sus propios
        clientes.
      </p>

      <H2>Condiciones y privacidad</H2>
      <p>
        El uso del servicio se rige por los{' '}
        <a href="/terminos" className="text-primary hover:underline">
          Términos de Servicio
        </a>{' '}
        y la{' '}
        <a href="/privacidad" className="text-primary hover:underline">
          Política de Privacidad
        </a>
        .
      </p>
    </LegalPage>
  );
}
