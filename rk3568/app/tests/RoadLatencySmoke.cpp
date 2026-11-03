#include "AsyncRoadWorker.h"
#include <QCoreApplication>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>
#include <algorithm>
#include <iostream>
#include <thread>

int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    try {
        if (argc != 4) throw std::runtime_error("sample output mask required");
        cv::Mat image = cv::imread(argv[1]);
        if (image.empty()) throw std::runtime_error("sample missing");
        cv::Mat tile(360,640,CV_8UC3,cv::Scalar());
        const double scale=std::min(640.0/image.cols,360.0/image.rows);
        cv::Size size(std::lround(image.cols*scale),std::lround(image.rows*scale));
        cv::Mat target=tile(cv::Rect((640-size.width)/2,(360-size.height)/2,size.width,size.height));
        cv::resize(image,target,size);
        cv::Mat mosaic(720,1280,CV_8UC3);
        for(int i=0;i<4;++i) tile.copyTo(mosaic(cv::Rect((i%2)*640,(i/2)*360,640,360)));
        AsyncRoadWorker worker;
        unsigned mask=std::stoul(argv[3]);
        worker.configure(1,RoadInferenceWorker::Mode::Adas,-1,true,true,mask);
        quint64 sequence=0;
        QJsonArray samples;
        auto started=std::chrono::steady_clock::now(), next=started;
        const auto deadline=started+std::chrono::seconds(100);
        int events=0;
        while (std::chrono::steady_clock::now()<deadline && events<28) {
            const auto now=std::chrono::steady_clock::now();
            if(now>=next) {
                worker.submit(mosaic,++sequence,1);
                next=now+std::chrono::milliseconds(50);
            }
            RoadInferenceResult r;
            if(worker.takeResult(1,r)) {
                if(!r.error.isEmpty()) throw std::runtime_error(r.error.toStdString());
#ifdef ROAD_PER_SOURCE
                const int source=r.updatedSource;
                const double age=std::chrono::duration<double,std::milli>(now-r.cameraFrameAt[source-1]).count();
                const double cost=r.cameraInferenceMs[source-1];
                if (++events>8) samples.append(QJsonObject{{"source",source},{"age_ms",age},{"cost_ms",cost},
                    {"frame_sequence",double(r.cameraFrameSequences[source-1])},
                    {"cached_boxes",int(r.detections.size())},{"cycles",double(r.completedCycles)}});
#else
                const double age=std::chrono::duration<double,std::milli>(now-r.sourceFrameAt).count();
                ++events;
                // Same warm-up and number of per-camera observations as candidate.
                if(events>2) for(int source=1;source<=4;++source)
                    samples.append(QJsonObject{{"source",source},{"age_ms",age},
                        {"cost_ms",r.cameraInferenceMs[source-1]},
                        {"frame_sequence",double(r.sourceFrameSequence)},
                        {"cached_boxes",int(r.detections.size())}});
                if(events>=7) break;
#endif
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
        }
        worker.stop();
        if(samples.size()!=20) throw std::runtime_error("incomplete latency sample");
        std::vector<double> ages;
        for(const auto &v:samples) ages.push_back(v.toObject().value("age_ms").toDouble());
        std::sort(ages.begin(),ages.end());
        double sum=0; for(double a:ages) sum+=a;
        QJsonObject report{{"ok",true},{"model_mask",int(mask)},
            {"measurement","source snapshot to result publication; stored positive image, not live motion"},
            {"sample_count",samples.size()},{"age_mean_ms",sum/ages.size()},
            {"age_median_ms",(ages[9]+ages[10])/2},{"age_max_ms",ages.back()},
            {"samples",samples}};
        QFile output(QString::fromLocal8Bit(argv[2]));
        if(!output.open(QIODevice::WriteOnly)) throw std::runtime_error("report write failed");
        output.write(QJsonDocument(report).toJson());
        std::cout << QJsonDocument(QJsonObject{{"ok",true},{"mean_age_ms",sum/ages.size()},
            {"median_age_ms",(ages[9]+ages[10])/2}}).toJson(QJsonDocument::Compact).constData() << '\n';
        return 0;
    } catch(const std::exception &e) { std::cerr << e.what() << '\n'; return 1; }
}
