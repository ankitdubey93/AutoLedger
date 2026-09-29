import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { pageTitleFor } from '../utils/pageTitle';

/** Keeps `document.title` in step with the route. Renders nothing; mounted once, inside the router. */
export default function DocumentTitle() {
  const { pathname } = useLocation();
  useEffect(() => {
    document.title = pageTitleFor(pathname);
  }, [pathname]);
  return null;
}
