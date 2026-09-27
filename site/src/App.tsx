import { About, Footer } from './sections/about';
import { Api } from './sections/api';
import { Architecture, Comparison } from './sections/architecture';
import { Hero } from './sections/hero';
import { Nav } from './sections/nav';
import { Pricing } from './sections/pricing';
import { Stats } from './sections/stats';

export default function App() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Stats />
        <Architecture />
        <Comparison />
        <Api />
        <Pricing />
        <About />
      </main>
      <Footer />
    </>
  );
}
