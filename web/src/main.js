import { listen, load } from './store.js';

load().then(listen);
