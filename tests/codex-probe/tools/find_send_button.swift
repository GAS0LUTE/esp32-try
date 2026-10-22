// 在窗口截图中动态定位蓝色发送按钮；输出归一化中心点与像素数。
import ImageIO
import Foundation

guard CommandLine.arguments.count >= 2 else { print("{}"); exit(64) }
let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
      let img = CGImageSourceCreateImageAtIndex(src, 0, nil),
      let data = img.dataProvider?.data,
      let bytes = CFDataGetBytePtr(data) else { print("{}"); exit(1) }

let w = img.width, h = img.height
let bpp = img.bitsPerPixel / 8
var sumX = 0.0, sumY = 0.0, count = 0
for y in 0..<h {
    for x in 0..<w {
        let i = (y * w + x) * bpp
        let r = Double(bytes[i]), g = Double(bytes[i + 1]), b = Double(bytes[i + 2])
        if b > 170 && r < 130 && g < 180 && b - r > 90 && b - g > 60 {
            sumX += Double(x); sumY += Double(y); count += 1
        }
    }
}
if count < 50 { print("{\"count\":\(count)}"); exit(0) }
let cx = sumX / Double(count) / Double(w)
let cy = sumY / Double(count) / Double(h)
print("{\"count\":\(count),\"x\":\(cx),\"y\":\(cy),\"width\":\(w),\"height\":\(h)}")
