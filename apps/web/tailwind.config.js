/**
 * Design tokens lifted verbatim from the Stitch designs
 * (design/reference/*.html). Do not "tidy" these values — they are the
 * contract between the generated designs and this implementation.
 */
/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "#0A0A0A",
        surface: "#141414",
        "surface-dim": "#131313",
        "surface-bright": "#3a3939",
        "surface-container-lowest": "#0e0e0e",
        "surface-container-low": "#1c1b1b",
        "surface-container": "#201f1f",
        "surface-container-high": "#2a2a2a",
        "surface-container-highest": "#353534",
        "surface-variant": "#353534",
        "on-background": "#e5e2e1",
        "on-surface": "#e5e2e1",
        "on-surface-variant": "#b9ccb2",
        outline: "#84967e",
        "outline-variant": "#3b4b37",

        // Phosphor green — the terminal's primary accent.
        primary: "#00FF41",
        "primary-container": "#00ff41",
        "on-primary": "#003907",
        "on-primary-container": "#007117",
        "primary-fixed": "#72ff70",
        "primary-fixed-dim": "#00e639",
        "inverse-primary": "#006e16",

        secondary: "#ffd393",
        "secondary-container": "#fdaf00",
        "on-secondary": "#432c00",
        "on-secondary-container": "#694600",
        "secondary-fixed-dim": "#ffba43",

        tertiary: "#fff7f6",
        "tertiary-container": "#ffd2ce",
        "on-tertiary": "#68000b",
        "on-tertiary-container": "#bf1824",

        error: "#ffb4ab",
        "error-container": "#93000a",
        "on-error": "#690005",
        "on-error-container": "#ffdad6",

        "inverse-surface": "#e5e2e1",
        "inverse-on-surface": "#313030",
      },
      borderRadius: {
        DEFAULT: "0px",
        none: "0px",
        sm: "0px",
        md: "0px",
        lg: "0px",
        xl: "0px",
        "2xl": "0px",
        full: "9999px",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      keyframes: {
        // CRT-style flicker, matching the "HC + Flicker" design variants.
        flicker: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.82" },
        },
        pulseDot: {
          "0%, 100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.4", transform: "scale(0.85)" },
        },
      },
      animation: {
        flicker: "flicker 3s infinite",
        "pulse-dot": "pulseDot 1.4s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
