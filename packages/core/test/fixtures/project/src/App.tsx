export function App() {
  const apiUrl = import.meta.env.VITE_API_URL;
  const flag = import.meta.env["VITE_FEATURE_FLAG"];
  return <main data-api={apiUrl} data-flag={flag} />;
}
