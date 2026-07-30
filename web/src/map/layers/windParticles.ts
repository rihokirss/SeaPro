import type { Map as MapLibreMap } from 'maplibre-gl';
import { sampleWind, type Field } from '../interpolate';
import { windColor } from '../../lib/units';

/**
 * Animeeritud tuulevoog — osakesed, mis liiguvad tuulega kaasa ja jätavad
 * hääbuva jälje.
 *
 * Renderdus käib eraldi 2D-canvasel kaardi peal, mitte MapLibre'i kihina.
 * Põhjus: osakesed elavad EKRAANI koordinaatides ja neid tuleb iga kaadri
 * järel edasi nihutada. WebGL-kihina tähendaks see oma shaderit ja
 * tekstuuride haldamist; canvas annab sama tulemuse murdosaga koodist ja
 * jääb 60 fps juurde ka telefonis, sest jäljed tekivad läbipaistva musta
 * ristküliku joonistamisest, mitte iga jälje eraldi hoidmisest.
 *
 * Kaardi liikumise ajal animatsioon peatatakse: projitseerimine iga kaadri
 * jaoks liikuval kaardil oleks nii kallis kui ka visuaalselt segane.
 */

/** Mitu osakest 1000x1000 px ala kohta. Skaleerub ekraani suurusega. */
const PARTICLE_DENSITY = 1400;

/**
 * Osakese eluiga kaadrites — pärast seda tekib ta juhuslikku kohta uuesti.
 * Aeglasema tempo juures peab eluiga olema pikem, muidu kaoks osake enne,
 * kui ta jõuab nähtava vahemaa läbida.
 */
const MAX_AGE = 200;

/** Kui palju eelmisest kaadrist alles jääb (jälje pikkus). */
const TRAIL_FADE = 0.96;

/**
 * Visuaalne tempo: kraadi liikumist kaadris 1 m/s kohta.
 *
 * See EI OLE füüsikaliselt õige kiirus — päris tuul liigub kaardil nii
 * aeglaselt, et animatsioon paistaks seisvat. Väärtus on valitud silma järgi:
 * piisavalt, et voolu suund oleks kohe loetav, aga mitte nii kiiresti, et
 * pilt muutuks rahutuks ja kaardi lugemist segaks.
 *
 * Väärtus on kalibreeritud `REFERENCE_ZOOM`-i juures: 10 m/s tuul liigub seal
 * ~30 px/s. Enne suumikompensatsiooni pidi see olema tagasihoidlikum (0.18),
 * sest sisse suumides läks tempo niikuinii käest ära — nüüd, kui kiirus on
 * igal suumil ühesugune, kannatab põhitempo olla tunduvalt elavam.
 */
const SPEED_FACTOR = 0.5;

/**
 * Suumitase, mille juures `SPEED_FACTOR` on silma järgi paika sätitud.
 *
 * Sama mis `DEFAULT_ZOOM` serveris — see ongi vaade, mida enamik kasutajaid
 * kõige rohkem näeb, ja tempo on selle järgi valitud.
 */
const REFERENCE_ZOOM = 7;

/**
 * Kompenseerib suumi mõju animatsiooni tempole.
 *
 * Probleem: `SPEED_FACTOR` annab sammu KRAADIDES, aga osake joonistatakse
 * PIKSLITES. Üks kraad on aga iga suumitasemega kaks korda rohkem piksleid,
 * seega kahekordistus animatsiooni kiirus iga sisse suumimise sammuga. Vaikevaates
 * (z7) oli tempo paras, z12 juures juba 32x kiirem — pilt muutus rahutuks
 * täpselt siis, kui kasutaja tahab detaili vaadata.
 *
 * Lahendus: jaga samm suumi skaalaga, nii et EKRAANIL liiguvad osakesed
 * ühtlase tempoga sõltumata suumist. Animatsioon näeb igal tasemel välja
 * täpselt nagu vaikevaates.
 *
 * Väärtus 1 = täielik kompensatsioon. Väiksem (nt 0.85) jätaks sisse suumides
 * veidi kiirenemist alles, kui see kunagi soovitud on.
 */
const ZOOM_COMPENSATION = 1;

interface Particle {
  x: number;
  y: number;
  age: number;
  speed: number;
}

export class WindParticleLayer {
  #map: MapLibreMap;
  #canvas: HTMLCanvasElement;
  #ctx: CanvasRenderingContext2D;
  #particles: Particle[] = [];
  #field: Field | null = null;
  #raf: number | null = null;
  #running = false;
  #moving = false;
  #dpr = 1;

  constructor(map: MapLibreMap) {
    this.#map = map;

    const canvas = document.createElement('canvas');
    canvas.className = 'wind-particles';
    // Kiht ei tohi klikke püüda — kaardile vajutamine peab endiselt töötama.
    canvas.style.pointerEvents = 'none';
    this.#canvas = canvas;
    this.#ctx = canvas.getContext('2d', { alpha: true })!;

    map.getContainer().appendChild(canvas);

    map.on('resize', this.#onResize);
    map.on('movestart', this.#onMoveStart);
    map.on('moveend', this.#onMoveEnd);
    map.on('zoomstart', this.#onMoveStart);
    map.on('zoomend', this.#onMoveEnd);

    this.#onResize();
  }

  setField(field: Field | null): void {
    this.#field = field;
    if (field) this.#seed();
    else this.#clear();
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#canvas.style.display = 'block';
    this.#seed();
    this.#loop();
  }

  stop(): void {
    this.#running = false;
    if (this.#raf !== null) {
      cancelAnimationFrame(this.#raf);
      this.#raf = null;
    }
    this.#clear();
    this.#canvas.style.display = 'none';
  }

  destroy(): void {
    this.stop();
    this.#map.off('resize', this.#onResize);
    this.#map.off('movestart', this.#onMoveStart);
    this.#map.off('moveend', this.#onMoveEnd);
    this.#map.off('zoomstart', this.#onMoveStart);
    this.#map.off('zoomend', this.#onMoveEnd);
    this.#canvas.remove();
  }

  #onResize = (): void => {
    const { clientWidth, clientHeight } = this.#map.getContainer();
    // Piirame pikslitiheduse 2-ga: 3x retina-telefonil oleks pinnalaotus
    // 9-kordne ja animatsioon hakkaks akut sööma ilma nähtava kasuta.
    this.#dpr = Math.min(2, window.devicePixelRatio || 1);
    this.#canvas.width = clientWidth * this.#dpr;
    this.#canvas.height = clientHeight * this.#dpr;
    this.#canvas.style.width = `${clientWidth}px`;
    this.#canvas.style.height = `${clientHeight}px`;
    this.#ctx.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
    this.#seed();
  };

  #onMoveStart = (): void => {
    this.#moving = true;
    this.#clear();
  };

  #onMoveEnd = (): void => {
    this.#moving = false;
    this.#seed();
  };

  #clear(): void {
    const { clientWidth, clientHeight } = this.#map.getContainer();
    this.#ctx.clearRect(0, 0, clientWidth, clientHeight);
  }

  #seed(): void {
    const { clientWidth: w, clientHeight: h } = this.#map.getContainer();
    const count = Math.round((w * h * PARTICLE_DENSITY) / 1_000_000);
    this.#particles = Array.from({ length: count }, () => this.#spawn(w, h));
  }

  #spawn(w: number, h: number): Particle {
    return {
      x: Math.random() * w,
      y: Math.random() * h,
      // Juhuslik algvanus, muidu tekiksid kõik osakesed korraga uuesti ja
      // pilt "pulseeriks".
      age: Math.floor(Math.random() * MAX_AGE),
      speed: 0,
    };
  }

  #loop = (): void => {
    if (!this.#running) return;
    this.#raf = requestAnimationFrame(this.#loop);

    if (this.#moving || !this.#field) return;

    const { clientWidth: w, clientHeight: h } = this.#map.getContainer();
    const ctx = this.#ctx;

    // Jälg: joonista poolläbipaistev kustutuskiht eelmise kaadri peale.
    // `destination-out` võtab alfat maha, jättes värvid puutumata — nii
    // hääbub jälg puhtalt, ilma et taust tumeneks.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = `rgba(0,0,0,${1 - TRAIL_FADE})`;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';

    ctx.lineWidth = 1.4;
    ctx.lineCap = 'round';

    // Üks kord kaadris, mitte iga osakese kohta — suum on kogu kaadri jaoks sama.
    const zoomScale = 2 ** ((this.#map.getZoom() - REFERENCE_ZOOM) * ZOOM_COMPENSATION);

    for (const p of this.#particles) {
      p.age++;
      if (p.age > MAX_AGE) {
        Object.assign(p, this.#spawn(w, h), { age: 0 });
        continue;
      }

      const ll = this.#map.unproject([p.x, p.y]);
      const sample = sampleWind(this.#field, ll.lat, ll.lng);
      if (!sample) {
        // Väljaspool andmevälja — ära joonista, lase vananeda.
        p.age = MAX_AGE;
        continue;
      }

      // Teisenda kiirus ja suund ekraaninihkeks. Kasutame kahte projekteeritud
      // punkti, et nihe oleks õige ka kaardi servades, kus Mercatori venitus
      // on tugev.
      const rad = (sample.bearing * Math.PI) / 180;
      const stepDeg = (sample.speed * SPEED_FACTOR) / 3600 / zoomScale;
      const next = this.#map.project([
        ll.lng + (stepDeg * Math.sin(rad)) / Math.cos((ll.lat * Math.PI) / 180),
        ll.lat + stepDeg * Math.cos(rad),
      ]);

      ctx.strokeStyle = windColor(sample.speed);
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(next.x, next.y);
      ctx.stroke();

      p.x = next.x;
      p.y = next.y;
      p.speed = sample.speed;

      // Ekraanilt välja liikunud osake tekib kohe mujal — nii ei teki
      // allatuult tühja ala.
      if (p.x < -20 || p.x > w + 20 || p.y < -20 || p.y > h + 20) {
        Object.assign(p, this.#spawn(w, h), { age: 0 });
      }
    }
    ctx.globalAlpha = 1;
  };
}
