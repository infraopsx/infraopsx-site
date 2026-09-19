import rss from '@astrojs/rss';

const modules = import.meta.glob('./blog/*.md', { eager: true });

export function GET(context) {
  const items = Object.values(modules)
    .map((post) => ({
      title: post.frontmatter.title,
      description: post.frontmatter.description,
      pubDate: new Date(post.frontmatter.pubDate),
      link: post.frontmatter.zhPath
    }))
    .sort((a, b) => b.pubDate - a.pubDate);

  return rss({
    title: 'InfraOpsX 技术文章',
    description:
      'Linux、Docker、Kubernetes 与基础设施故障排查相关的实用技术记录。',
    site: context.site,
    items,
    customData: '<language>zh-CN</language>'
  });
}
