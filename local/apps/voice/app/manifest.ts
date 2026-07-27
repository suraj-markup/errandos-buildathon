import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    background_color: '#fffdf6',
    description: 'A tiny voice companion for safe, real-world errands.',
    display: 'standalone',
    name: 'ErrandOS',
    orientation: 'portrait',
    short_name: 'ErrandOS',
    start_url: '/',
    theme_color: '#fffdf6',
  };
}
