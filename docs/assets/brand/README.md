# Semantic Graphite

Semantic Graphite treats structure and negative space as the primary language of a serious documentation system. Forms should make relationships legible before words arrive. The mark and every composition should feel like a carefully ordered page with room for its syntax to breathe.

Graphite surfaces carry soft-white document geometry, giving the system a material sense of paper held inside a dark developer workspace. Cyan is reserved for AST analysis and navigation, green for validated states, and amber only for warnings. Color is signal, never ornament.

Repeated nodes, connectors, and exact grid rhythm encode semantic structure rather than decoration. Alignments should reveal how a change moves through code, impact planning, and documentation. Scale and spacing should be deliberate enough that the eye can follow the system without a legend.

Typography is sparse system monospace and subordinate to form. Labels act as quiet anchors while geometry, hierarchy, and negative space carry the meaning. Composition stays calm, balanced, and generous so the artifact remains useful in a repository, an avatar, or a narrow crop.

Every alignment and export must look meticulously crafted, repeatedly refined, and master-level precise. The final identity should feel labored over by a practitioner with deep expertise, with no convenient flourish left unexamined. Precision is the personality.

## Usage rules

- Palette: paper `#F7F4EE`, sheet `#FFFDF8`, graphite `#1E252E`, analysis cyan `#1BA8E8`, validated green `#2AC769`, warning amber `#E5A93A`.
- Logo: `staledocs-logo.png` is the 1024-pixel transparent export of the avatar artwork. Use it wherever the mark sits on a page, header, or plugin listing; it works on light and dark backgrounds without a plate.
- Logo alt text: `StaleDocs logo: a graphite code panel with a cyan rail beside a warm-white documentation sheet.`
- Minimum size: use the logo at 32 pixels minimum and pair it with the `StaleDocs` wordmark set in system monospace, `Stale` in graphite and `Docs` in cyan.
- Repository avatar: use `staledocs-avatar.png`, the 512-pixel opaque export of `staledocs-avatar-source.png`, for GitHub and other platforms that need a square avatar. Do not recrop it.
- Plugin icon: `integrations/claude/staledocs/assets/icon.png` is the 512-pixel transparent export of `staledocs-logo.png`.
- Storefront imagery: the README hero is `../demo/staledocs-flow-scene.png`, followed by `../review-comment.png`, a GitHub-styled render of real `staledocs review --format markdown` output. Use the light social composition only for the GitHub social preview. The dark poster is kept as a source asset and is not referenced from the README.
- Raster sources: `staledocs-social-preview-source.png`, `staledocs-flow-poster-source.png`, and `staledocs-flow-scene.png` are the maintainer-approved high-resolution sources. Their neighboring SVG compositions define accessible descriptions, safe output canvases, and deterministic overlays; every image reference must remain local to this repository. Track pixel-only PNG exports without provider branding metadata.
- Semantic color: cyan indicates AST analysis or navigation, green indicates a validated state, and amber indicates a warning only.
- Accessibility: preserve the title and description in the SVG sources, provide the alt text above for rendered images, and do not rely on color alone to communicate state.
- Original design: these assets are repository-owned original work and must not include a third-party logo, remote font, remote image, or borrowed brand shape.
- Typography: use system monospace for the wordmark and keep text sparse, legible, and subordinate to the geometry.

`staledocs-avatar-source.png` is the maintainer-selected 1254-pixel source for the avatar and logo. Re-export the avatar with `sips -s format png --resampleHeightWidth 512 512 docs/assets/brand/staledocs-avatar-source.png --out docs/assets/brand/staledocs-avatar.png`. The transparent logo is the same artwork with the background removed; re-export the plugin icon from it at 512 pixels. Re-export storefront PNGs from their neighboring SVG compositions and tracked local raster sources. Do not patch PNG bytes or add decorative metrics, graphs without data, robots, people, wands, sparkles, or provider marks.
