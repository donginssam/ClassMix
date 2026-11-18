import { useEffect, useState } from "react";
import { api } from "@/lib/api";

/** 디버그 빌드에서만 샘플 파일 경로를 준다(nuclass2의 "샘플 바로 적용"에 해당하는 개발용 기능). */
export function useDevSamples() {
  const [paths, setPaths] = useState<{ xlsx: string; pdf: string } | null>(null);
  useEffect(() => {
    api
      .devSamplePaths()
      .then(setPaths)
      .catch(() => setPaths(null));
  }, []);
  return paths;
}
