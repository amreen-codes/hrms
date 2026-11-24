export default { content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: { extend: { colors: { navy: { 950: '#070f2b', 900: '#0b1a3f', 800: '#10224f', 700: '#1a3270' }, brand: '#4f46e5', gold: { 400: '#e3c16f', 500: '#c9a227' } },
    fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'], serif: ['"Source Serif 4"', 'Georgia', 'serif'] },
    boxShadow: { soft: '0 1px 2px rgba(15,23,42,.04), 0 8px 24px -8px rgba(15,23,42,.10)', glow: '0 8px 30px -6px rgba(79,70,229,.45)' } } }, plugins: [] };
