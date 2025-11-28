# Satyanaash 2.0 - Frontend

Modern React + TypeScript frontend for Satyanaash API testing framework.

## 🚀 Quick Start

```bash
# Navigate to frontend directory
cd web/web/web/frontend

# Install dependencies
npm install

# Start development server
npm run dev
```

The application is now running at **http://localhost:5173/**

## 📁 Project Structure

```
src/
├── components/
│   ├── ui/              # Reusable UI components
│   └── Layout.tsx       # Main layout component
├── pages/
│   ├── ProjectsDashboard.tsx   # Home page - project list
│   ├── GraphEditor.tsx         # Visual graph editor
│   └── ExecutionDashboard.tsx  # Real-time execution monitoring
├── hooks/
│   └── useProjects.ts  # API hooks using TanStack Query
├── lib/
│   ├── api.ts          # Axios API client
│   └── utils.ts        # Utility functions
├── types/
│   └── index.ts        # TypeScript type definitions
└── index.css           # Global styles + Tailwind
```

## 🎨 Features Implemented

### ✅ Core Pages

1. **Projects Dashboard** - Overview, project cards, create modal
2. **Graph Editor** - Visual graph builder using react-flow
3. **Execution Dashboard** - Real-time monitoring with live log

### 🎯 Component Library

- Button, Card, Badge, Modal, Input/Textarea components
- Tailwind CSS styling with custom color palette
- Responsive design

### 🔌 API Integration

- TanStack Query for data fetching
- Axios HTTP client
- Ready for backend integration

## 🔧 Technology Stack

- React 18 + TypeScript
- Vite (build tool)
- Tailwind CSS
- react-flow (graph editor)
- TanStack Query
- Lucide React (icons)

## 📝 Next Steps

- Connect to Satyanaash REST API backend
- Implement WebSocket for real-time updates
- Add custom graph nodes (conditional, loop, parallel)
- Implement test case editing
- Add execution history with charts
