import type { Metadata } from 'next';
import { LegalPage, H2 } from '../../components/legal/legal-page';

export const metadata: Metadata = {
  title: 'Sobre nosotros — Catalog',
  robots: { index: true },
};

export default function SobreNosotrosPage() {
  return (
    <LegalPage title="Sobre nosotros">
      <p>
        <strong>Wegox</strong> construye software para que negocios reales vendan mejor en internet, sin
        pelearse con plataformas genéricas ni depender de un técnico para cada cambio.
      </p>
      <p>
        <strong>Catalog</strong> nació de una observación simple: la mayoría de los negocios no
        necesita un e-commerce gigante — necesita que su catálogo esté impecable, que su sitio web lo
        muestre al instante y que los pedidos lleguen ordenados, listos para gestionar en el panel o en
        persona. Eso es exactamente lo que hicimos, en español y pensado para cómo se vende en Venezuela y
        Latinoamérica.
      </p>

      <H2>Lo que nos importa</H2>
      <ul className="list-disc space-y-1 pl-6">
        <li>
          <strong>Tus datos son tuyos.</strong> Tu catálogo, tus fotos y tus ventas te pertenecen; puedes
          exportarlos cuando quieras.
        </li>
        <li>
          <strong>Sin comisiones por venta.</strong> Cobramos una suscripción clara; lo que vendes es tuyo,
          de principio a fin.
        </li>
        <li>
          <strong>Acompañamiento real.</strong> Configuramos tu catálogo y tu sitio web contigo, y el
          soporte lo responde una persona, en español.
        </li>
      </ul>

      <H2>La empresa</H2>
      <p>
        Wegox LLC es una empresa constituida en Delaware, Estados Unidos, con operación y soporte enfocados
        en Venezuela y Latinoamérica. Además de Catalog desarrollamos <strong>Bukky</strong>, nuestro
        motor de reservas y citas para negocios de servicios.
      </p>
      <p>
        ¿Hablamos?{' '}
        <a href="mailto:support@wegox.io" className="text-primary hover:underline">
          support@wegox.io
        </a>
      </p>
    </LegalPage>
  );
}
