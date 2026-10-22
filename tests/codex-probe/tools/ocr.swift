import Vision
import ImageIO
import Foundation

let path = CommandLine.arguments[1]
let url = URL(fileURLWithPath: path)
guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
      let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { exit(1) }
let request = VNRecognizeTextRequest()
request.recognitionLevel = .fast
let handler = VNImageRequestHandler(cgImage: img, options: [:])
do {
    try handler.perform([request])
    for obs in request.results ?? [] {
        if let top = obs.topCandidates(1).first {
            let b = obs.boundingBox
            print("\(top.string)\t\(b.origin.x),\(b.origin.y),\(b.size.width),\(b.size.height)")
        }
    }
} catch {
    print("OCR_ERROR: \(error)")
}
