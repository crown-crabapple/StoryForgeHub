/** One inspector section: uppercase 12px muted heading, then content. @param {{ title: import('react').ReactNode, children: import('react').ReactNode }} props */
export function InspectorSection({ title, children }) {
  return (
    <section className="inspector-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
