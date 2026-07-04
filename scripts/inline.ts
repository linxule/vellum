const html = await Bun.file('index.html').text()
const js = await Bun.file('dist/main.js').text()

const artifact = html.replace(
  '<script type="module" src="dist/main.js"></script>',
  () => `<script type="module">\n${js}\n</script>`
)

await Bun.write('dist/vellum.html', artifact)
console.log(`Built dist/vellum.html (${(artifact.length / 1024).toFixed(1)} KB)`)
