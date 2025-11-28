import React from 'react';
import { FolderOpen, Settings } from 'lucide-react';
import { Link, useRouterState } from '@tanstack/react-router';

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
  return (
    <div className="min-h-screen bg-neutral-50">
      {/* Top Navigation */}
      <nav className="bg-white border-b border-neutral-200 h-16">
        <div className="max-w-7xl mx-auto px-4 h-full flex items-center justify-between">
          <div className="flex items-center gap-8">
            <Link to="/" className="flex items-center gap-2">
              <div className="w-8 h-8 bg-primary-500 rounded-lg flex items-center justify-center">
                <span className="text-white font-bold text-sm">S</span>
              </div>
              <span className="text-xl font-bold text-neutral-900">
                Satyanaash
              </span>
            </Link>

            <div className="flex items-center gap-1">
              <NavLink to="/" icon={<FolderOpen className="w-4 h-4" />}>
                Projects
              </NavLink>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <button className="p-2 hover:bg-neutral-100 rounded-lg transition-colors">
              <Settings className="w-5 h-5 text-neutral-600" />
            </button>
            <div className="w-8 h-8 bg-primary-100 rounded-full flex items-center justify-center">
              <span className="text-primary-600 font-medium text-sm">U</span>
            </div>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main>{children}</main>
    </div>
  );
}

function NavLink({
  to,
  icon,
  children,
}: {
  to: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const router = useRouterState();
  const isActive = router.location.pathname === to;

  return (
    <Link
      to={to}
      className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors ${
        isActive
          ? 'bg-primary-50 text-primary-600 font-medium'
          : 'text-neutral-600 hover:bg-neutral-100'
      }`}
    >
      {icon}
      <span>{children}</span>
    </Link>
  );
}
