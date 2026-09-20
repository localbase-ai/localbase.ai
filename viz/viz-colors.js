// LocalBase Visualization Standard Colors
// Use these colors for consistent theming across all visualizations

const VIZ_COLORS = {
  // Background colors
  background: '#0a0e1a',
  backgroundLight: '#141824',

  // Border colors
  border: '#1f2937',
  borderLight: '#374151',

  // Text colors
  textPrimary: '#ffffff',
  textSecondary: '#e0e6ed',
  textMuted: '#8b92a7',
  textDisabled: '#6b7280',

  // Accent colors
  accentGreen: '#4ade80',
  accentGreenDark: '#22c55e',
  accentBlue: '#3b82f6',
  accentRed: '#ef4444',
  accentYellow: '#f59e0b',
  accentPurple: '#a855f7',

  // Chart colors (for multi-series)
  chartColors: [
    '#4ade80',  // Green
    '#3b82f6',  // Blue
    '#f59e0b',  // Orange
    '#a855f7',  // Purple
    '#ef4444',  // Red
    '#10b981',  // Emerald
    '#8b5cf6',  // Violet
    '#f97316',  // Orange-red
  ],

  // Grid colors
  gridColor: '#1f2937',
  gridStroke: '#374151',
}

// ApexCharts theme configuration
const APEXCHARTS_THEME = {
  mode: 'dark',
  palette: 'palette1'
}

const APEXCHARTS_COMMON = {
  chart: {
    background: 'transparent',
    foreColor: VIZ_COLORS.textMuted,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif',
    toolbar: {
      show: true,
      tools: {
        download: true,
        zoom: true,
        zoomin: true,
        zoomout: true,
        pan: true,
        reset: true
      }
    }
  },
  theme: APEXCHARTS_THEME,
  grid: {
    borderColor: VIZ_COLORS.gridColor,
    strokeDashArray: 4
  },
  xaxis: {
    labels: {
      style: {
        colors: VIZ_COLORS.textMuted
      }
    },
    axisBorder: {
      color: VIZ_COLORS.border
    },
    axisTicks: {
      color: VIZ_COLORS.border
    }
  },
  yaxis: {
    labels: {
      style: {
        colors: VIZ_COLORS.textMuted
      }
    }
  },
  tooltip: {
    theme: 'dark',
    style: {
      fontSize: '12px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif'
    }
  },
  legend: {
    labels: {
      colors: VIZ_COLORS.textSecondary
    }
  }
}

// CSS template for visualization pages
const VIZ_CSS_TEMPLATE = `
body {
  margin: 0;
  padding: 20px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
  background: ${VIZ_COLORS.background};
  color: ${VIZ_COLORS.textSecondary};
}

.container {
  max-width: 1400px;
  margin: 0 auto;
}

h1, h2, h3, h4, h5, h6 {
  color: ${VIZ_COLORS.textPrimary};
  font-weight: 600;
}

.subtitle {
  font-size: 12px;
  color: ${VIZ_COLORS.textMuted};
  margin-bottom: 15px;
}

.card {
  background: ${VIZ_COLORS.backgroundLight};
  border: 1px solid ${VIZ_COLORS.border};
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 20px;
}

.stat-card {
  background: ${VIZ_COLORS.backgroundLight};
  border: 1px solid ${VIZ_COLORS.border};
  border-radius: 8px;
  padding: 20px;
}

.stat-label {
  font-size: 12px;
  color: ${VIZ_COLORS.textMuted};
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 8px;
}

.stat-value {
  font-size: 32px;
  font-weight: 700;
  color: ${VIZ_COLORS.textPrimary};
}

#loading {
  text-align: center;
  padding: 40px;
  color: ${VIZ_COLORS.textMuted};
}
`

// Export for use in Node.js or browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    VIZ_COLORS,
    APEXCHARTS_THEME,
    APEXCHARTS_COMMON,
    VIZ_CSS_TEMPLATE
  }
}
