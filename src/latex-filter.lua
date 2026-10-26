-- Keeps a rendered LaTeX review page inert, like the Markdown renderer does:
-- unsafe link and image schemes lose their target but keep their readable
-- label, and raw HTML is never passed through.

local function safe(target, image)
  local probe = target:gsub("[%c%s]", "")
  local scheme = probe:match("^([%a][%w+.-]*):")
  if not scheme then return true end
  scheme = scheme:lower()
  if scheme == "http" or scheme == "https" then return true end
  if not image and scheme == "mailto" then return true end
  if image and probe:lower():match("^data:image/[%w]+;base64,") then
    local kind = probe:lower():match("^data:image/([%w]+);base64,")
    return kind == "avif" or kind == "gif" or kind == "jpeg" or kind == "jpg" or kind == "png" or kind == "webp"
  end
  return false
end

function Link(el)
  if safe(el.target, false) then return nil end
  return el.content
end

function Image(el)
  if safe(el.src, true) then return nil end
  return pandoc.Str(pandoc.utils.stringify(el.caption))
end

function RawInline(el)
  if el.format:match("html") then return {} end
end

function RawBlock(el)
  if el.format:match("html") then return {} end
end
