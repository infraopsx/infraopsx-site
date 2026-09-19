import rss from '@astrojs/rss';

const modules = import.meta.glob('./blog/*.md', { eager: true });

export function GET(context) {
  const items = Object.values(modules)
    .map((post) => ({
      title: post.frontmatter.title,
      description: post.frontmatter.description,
      pubDate: new Date(post.frontmatter.pubDate),
      link: post.frontmatter.enPath
    }))
    .sort((a, b) => b.pubDate - a.pubDate);

  return rss({
    title: 'InfraOpsX Technical Articles',
    description:
      'Practical Linux, Docker, Kubernetes and infrastructure troubleshooting notes.',
    site: context.site,
    items,
    customData: '<language>en</language>'
  });
}
