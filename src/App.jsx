import { useEffect, useMemo, useState } from "react";
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import Footer from "./components/Footer";
import Header from "./components/Header";
import ProgressIndicator from "./components/ProgressIndicator";
import Sidebar from "./components/Sidebar";
import docsData from "./data/docs.json";
import { usePersistentState } from "./hooks/usePersistentState";
import Documentation from "./pages/Documentation";

const defaultCategory = docsData.categories[0];
const defaultSection = defaultCategory.sections[0];

const App = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const prefersDark =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  const [theme, setTheme] = usePersistentState(
    "doc-theme",
    prefersDark ? "dark" : "light"
  );
  const [bookmarks, setBookmarks] = usePersistentState("doc-bookmarks", []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  const handleBookmarkToggle = (key) => {
    setBookmarks((prev) =>
      prev.includes(key)
        ? prev.filter((entry) => entry !== key)
        : [...prev, key]
    );
  };

  const handleNavigate = ({ categoryId, sectionId }) => {
    navigate(`/${categoryId}/${sectionId}`);
    setSidebarOpen(false);
  };

  const bookmarkMeta = useMemo(
    () =>
      bookmarks
        .map((key) => {
          const [categoryId, sectionId] = key.split(":");
          const category = docsData.categories.find(
            (entry) => entry.id === categoryId
          );
          const section = category?.sections.find(
            (entry) => entry.id === sectionId
          );
          if (!category || !section) return null;
          return {
            key,
            categoryId,
            sectionId,
            categoryTitle: category.title,
            sectionTitle: section.title,
          };
        })
        .filter(Boolean),
    [bookmarks]
  );

  const pathSegments = location.pathname.replace(/^\/+/, "").split("/");
  const routeSegments = pathSegments.filter(Boolean);
  const [
    currentCategoryId = defaultCategory.id,
    currentSectionId = defaultSection.id,
  ] = routeSegments;

  return (
    <div className="relative min-h-screen bg-gradient-to-b from-slate-50 via-white to-slate-100 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950">
      <ProgressIndicator />
      <div className="mx-auto flex gap-4 px-2 py-2 lg:px-4">
        <Sidebar
          docs={docsData}
          activeCategoryId={currentCategoryId}
          activeSectionId={currentSectionId}
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          onNavigate={handleNavigate}
        />
        <div className="glass-panel flex flex-1 flex-col rounded-3xl bg-white/80 dark:bg-slate-900/70">
          <Header
            theme={theme}
            onThemeToggle={() => setTheme(theme === "dark" ? "light" : "dark")}
            onToggleSidebar={() => setSidebarOpen((value) => !value)}
            docs={docsData}
            onNavigate={handleNavigate}
            bookmarksMeta={bookmarkMeta}
          />
          <main className="flex-1 px-3 py-3 md:px-6">
            <Routes>
              <Route
                path="/"
                element={
                  <Navigate
                    to={`/${defaultCategory.id}/${defaultSection.id}`}
                    replace
                  />
                }
              />
              <Route
                path="/:categoryId/:sectionId"
                element={
                  <Documentation
                    docs={docsData}
                    bookmarks={bookmarks}
                    onBookmarkToggle={handleBookmarkToggle}
                  />
                }
              />
              <Route
                path="*"
                element={
                  <Navigate
                    to={`/${defaultCategory.id}/${defaultSection.id}`}
                    replace
                  />
                }
              />
            </Routes>
          </main>
          <Footer />
        </div>
      </div>
    </div>
  );
};

export default App;
