/** First in tab order; visible only while focused. The target is the <main id="main"> of each page. */
export function SkipLink() {
  return (
    <a href="#main" className="skip-link">
      Skip to content
    </a>
  );
}
